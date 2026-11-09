import { badRequest } from '@sim/api-kit';
import type {
  ErrorFingerprint,
  LogEntry,
  LogEntryInput,
  LogHistogram,
  LogServiceStats,
  LogSummary,
  Severity,
} from '@sim/contracts/logs';
import { logMessage } from '@sim/contracts/logs';
import { fingerprintOf, normalizeMessage } from './normalize';
import { type Predicate, SEVERITY_RANK } from './query';

interface Rec {
  e: LogEntry;
  /** Parsed `timestamp` (ms). */
  ts: number;
}

export interface Window {
  /** Inclusive lower bound (ms). */
  since?: number;
  /** Inclusive upper bound (ms). */
  until?: number;
  /** Only entries with seq > afterSeq. */
  afterSeq?: number;
}

const ERROR_RANK = SEVERITY_RANK.ERROR;
const WARNING_RANK = SEVERITY_RANK.WARNING;

/** Nice bucket sizes for histograms (seconds). */
const BUCKET_SIZES = [
  1, 2, 5, 10, 15, 30, 60, 120, 180, 300, 360, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600,
  43200, 86400,
];

const encodeKey = (ts: number, seq: number) => Buffer.from(`${ts}:${seq}`).toString('base64url');

function decodeKey(cursor: string): [number, number] {
  const m = Buffer.from(cursor, 'base64url')
    .toString()
    .match(/^(-?\d+):(\d+)$/);
  if (!m) throw badRequest('Invalid cursor');
  return [Number(m[1]), Number(m[2])];
}

/** (ts, seq) ordering. */
const cmpKey = (a: Rec, ts: number, seq: number) => a.ts - ts || a.e.seq - seq;

/**
 * In-memory ring buffer of log entries in arrival (seq) order. Queries order by timestamp;
 * the stream and tail read in seq order. Readers waiting for new data are woken on ingest.
 */
export class LogStore {
  private recs: Rec[] = [];
  private byId = new Map<string, Rec>();
  private seq = 0;
  private waiters = new Set<() => void>();
  private rateSamples: { t: number; n: number }[] = [];
  /** Bumped on reset so streams can tell subscribers to clear their view. */
  epoch = 0;

  constructor(readonly capacity = 200_000) {}

  get size() {
    return this.recs.length;
  }

  get lastSeq() {
    return this.seq;
  }

  ingest(inputs: LogEntryInput[], now = new Date()): number {
    const receiveTimestamp = now.toISOString();
    const nowMs = now.getTime();
    let accepted = 0;
    for (const input of inputs) {
      if (input.insertId && this.byId.has(input.insertId)) continue; // GCP dedupes by insertId
      const seq = ++this.seq;
      const ts = Date.parse(input.timestamp);
      const insertId =
        input.insertId ?? `${nowMs.toString(36)}${seq.toString(36).padStart(6, '0')}`;
      const { insertId: _ignored, logName, timestamp, severity, resource, labels, ...rest } = input;
      const entry: LogEntry = {
        insertId,
        seq,
        logName,
        timestamp: new Date(ts).toISOString(),
        receiveTimestamp,
        severity,
        resource,
        labels,
        ...rest,
      };
      const rec = { e: entry, ts };
      this.recs.push(rec);
      this.byId.set(insertId, rec);
      accepted++;
    }
    this.evict();
    this.trackRate(nowMs, accepted);
    if (accepted > 0) this.wake();
    return accepted;
  }

  get(insertId: string): LogEntry | undefined {
    return this.byId.get(insertId)?.e;
  }

  clear() {
    this.recs = [];
    this.byId.clear();
    this.rateSamples = [];
    this.epoch++;
    this.wake();
  }

  /** Entries ingested per second over the last 10s. */
  ingestPerSec(now = Date.now()): number {
    this.rateSamples = this.rateSamples.filter((s) => now - s.t < 10_000);
    const total = this.rateSamples.reduce((sum, s) => sum + s.n, 0);
    return Math.round((total / 10) * 10) / 10;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Matching records in seq order. */
  private scan(pred: Predicate, win: Window = {}): Rec[] {
    const out: Rec[] = [];
    const { since = -Infinity, until = Infinity } = win;
    const start = win.afterSeq !== undefined ? this.indexAfter(win.afterSeq) : 0;
    const recs = this.recs;
    for (let i = start; i < recs.length; i++) {
      const r = recs[i]!;
      if (r.ts < since || r.ts > until) continue;
      if (pred(r.e)) out.push(r);
    }
    return out;
  }

  /** Index of the first record with seq > afterSeq. */
  private indexAfter(afterSeq: number): number {
    let lo = 0;
    let hi = this.recs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.recs[mid]!.e.seq <= afterSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Time-ordered page with a keyset cursor (stable while new entries arrive). */
  search(
    pred: Predicate,
    win: Window,
    opts: { order: 'asc' | 'desc'; limit: number; cursor?: string },
  ): { items: LogEntry[]; next_cursor: string | null; total: number } {
    const matches = this.scan(pred, win);
    matches.sort((a, b) => a.ts - b.ts || a.e.seq - b.e.seq); // nearly sorted: TimSort is ~O(n)
    const total = matches.length;
    const items: LogEntry[] = [];
    let next_cursor: string | null = null;

    if (opts.order === 'asc') {
      let i = 0;
      if (opts.cursor) {
        const [ts, seq] = decodeKey(opts.cursor);
        i = lowerBound(matches, (r) => cmpKey(r, ts, seq) <= 0);
      }
      for (; i < matches.length && items.length < opts.limit; i++) items.push(matches[i]!.e);
      if (i < matches.length && items.length > 0) {
        const last = matches[i - 1]!;
        next_cursor = encodeKey(last.ts, last.e.seq);
      }
    } else {
      let i = matches.length - 1;
      if (opts.cursor) {
        const [ts, seq] = decodeKey(opts.cursor);
        i = lowerBound(matches, (r) => cmpKey(r, ts, seq) < 0) - 1;
      }
      for (; i >= 0 && items.length < opts.limit; i--) items.push(matches[i]!.e);
      if (i >= 0 && items.length > 0) {
        const last = matches[i + 1]!;
        next_cursor = encodeKey(last.ts, last.e.seq);
      }
    }
    return { items, next_cursor, total };
  }

  /**
   * Arrival-order read for tails and streams: up to `limit` matching entries with
   * seq > afterSeq. `cursor` is the seq to continue from (the last returned entry, or the last
   * scanned seq when nothing matched), so non-matching entries are never rescanned.
   */
  readAfter(
    afterSeq: number,
    pred: Predicate,
    limit: number,
    win: Window = {},
  ): { items: LogEntry[]; cursor: number; hasMore: boolean } {
    const { since = -Infinity, until = Infinity } = win;
    const items: LogEntry[] = [];
    // A cursor from before an API restart may be ahead of us: clamp it.
    afterSeq = Math.min(Math.max(afterSeq, 0), this.seq);
    let cursor = afterSeq;
    const recs = this.recs;
    for (let i = this.indexAfter(afterSeq); i < recs.length; i++) {
      const r = recs[i]!;
      if (items.length >= limit) return { items, cursor, hasMore: true };
      cursor = r.e.seq;
      if (r.ts < since || r.ts > until) continue;
      if (pred(r.e)) items.push(r.e);
    }
    return { items, cursor: Math.max(cursor, this.seq), hasMore: false };
  }

  /** The latest `limit` matching entries in seq order. */
  latest(pred: Predicate, limit: number, win: Window = {}): LogEntry[] {
    const { since = -Infinity, until = Infinity } = win;
    const out: LogEntry[] = [];
    for (let i = this.recs.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.recs[i]!;
      if (r.ts < since || r.ts > until) continue;
      if (pred(r.e)) out.push(r.e);
    }
    return out.reverse();
  }

  histogram(pred: Predicate, since: number, until: number): LogHistogram {
    // Smallest nice bucket size that keeps the (aligned) range within ~60 buckets.
    const bucketsFor = (sizeMs: number) =>
      Math.max(1, Math.ceil((until - Math.floor(since / sizeMs) * sizeMs) / sizeMs));
    const size = BUCKET_SIZES.find((s) => bucketsFor(s * 1000) <= 61) ?? 86400;
    const sizeMs = size * 1000;
    const first = Math.floor(since / sizeMs) * sizeMs;
    const count = bucketsFor(sizeMs);
    const buckets = Array.from({ length: count }, (_, i) => ({
      start: new Date(first + i * sizeMs).toISOString(),
      total: 0,
      counts: {} as Partial<Record<Severity, number>>,
    }));
    let total = 0;
    for (const r of this.scan(pred, { since, until })) {
      const b = buckets[Math.min(count - 1, Math.floor((r.ts - first) / sizeMs))];
      if (!b) continue;
      b.total++;
      b.counts[r.e.severity] = (b.counts[r.e.severity] ?? 0) + 1;
      total++;
    }
    return {
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      bucket_seconds: size,
      total,
      buckets,
    };
  }

  summary(pred: Predicate, since: number, until: number, limit: number): LogSummary {
    interface Group {
      fp: ErrorFingerprint;
      maxRank: number;
      firstTs: number;
      lastTs: number;
      statuses: Map<number, number>;
    }
    const groups = new Map<string, Group>();
    const matches = this.scan(pred, { since, until });
    for (const r of matches) {
      const e = r.e;
      const app = e.labels?.app_tla ?? '';
      const service = e.resource?.labels?.container_name ?? '';
      const message = logMessage(e) || e.jsonPayload?.error?.message || '';
      const pattern = normalizeMessage(message);
      const key = `${app}\u0000${service}\u0000${pattern}`;
      let g = groups.get(key);
      const rank = SEVERITY_RANK[e.severity] ?? 0;
      if (!g) {
        g = {
          fp: {
            app_tla: app,
            service,
            severity: e.severity,
            fingerprint: fingerprintOf(app, service, pattern),
            pattern,
            count: 0,
            first_seen: e.timestamp,
            last_seen: e.timestamp,
            sample_message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
            sample_insert_id: e.insertId,
          },
          maxRank: rank,
          firstTs: r.ts,
          lastTs: r.ts,
          statuses: new Map(),
        };
        if (e.jsonPayload?.error?.type) g.fp.error_type = e.jsonPayload.error.type;
        groups.set(key, g);
      }
      g.fp.count++;
      if (rank > g.maxRank) {
        g.maxRank = rank;
        g.fp.severity = e.severity;
      }
      if (r.ts < g.firstTs) {
        g.firstTs = r.ts;
        g.fp.first_seen = e.timestamp;
      }
      if (r.ts >= g.lastTs) {
        // Most recent occurrence is the most useful sample.
        g.lastTs = r.ts;
        g.fp.last_seen = e.timestamp;
        g.fp.sample_message = message.length > 500 ? `${message.slice(0, 500)}…` : message;
        g.fp.sample_insert_id = e.insertId;
        if (e.jsonPayload?.error?.type) g.fp.error_type = e.jsonPayload.error.type;
      }
      const status = e.httpRequest?.status;
      if (typeof status === 'number') g.statuses.set(status, (g.statuses.get(status) ?? 0) + 1);
    }
    const items = [...groups.values()]
      .map((g) => {
        if (g.statuses.size > 0) {
          g.fp.http_status = [...g.statuses.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        }
        return g;
      })
      .sort((a, b) => b.fp.count - a.fp.count || b.maxRank - a.maxRank || a.firstTs - b.firstTs)
      .slice(0, limit)
      .map((g) => g.fp);
    return {
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      total_matched: matches.length,
      items,
    };
  }

  services(pred: Predicate, since: number, until: number): LogServiceStats[] {
    interface Acc {
      s: LogServiceStats;
      lastTs: number;
      lastErrTs: number;
    }
    const byService = new Map<string, Acc>();
    for (const r of this.scan(pred, { since, until })) {
      const e = r.e;
      const service = e.resource?.labels?.container_name ?? '';
      const app = e.labels?.app_tla ?? '';
      const key = `${app}\u0000${service}`;
      let acc = byService.get(key);
      if (!acc) {
        acc = {
          s: {
            service,
            app_tla: app,
            app_name: e.labels?.app_name ?? '',
            total: 0,
            counts: {},
            errors: 0,
            warnings: 0,
            error_rate: 0,
            last_seen: e.timestamp,
            last_error_at: null,
          },
          lastTs: r.ts,
          lastErrTs: -Infinity,
        };
        byService.set(key, acc);
      }
      const s = acc.s;
      s.total++;
      s.counts[e.severity] = (s.counts[e.severity] ?? 0) + 1;
      const rank = SEVERITY_RANK[e.severity] ?? 0;
      if (rank >= ERROR_RANK) {
        s.errors++;
        if (r.ts >= acc.lastErrTs) {
          acc.lastErrTs = r.ts;
          s.last_error_at = e.timestamp;
        }
      } else if (rank === WARNING_RANK) {
        s.warnings++;
      }
      if (r.ts >= acc.lastTs) {
        acc.lastTs = r.ts;
        s.last_seen = e.timestamp;
      }
    }
    return [...byService.values()]
      .map(({ s }) => ({
        ...s,
        error_rate: s.total ? Math.round((s.errors / s.total) * 1e4) / 1e4 : 0,
      }))
      .sort(
        (a, b) =>
          b.errors - a.errors ||
          b.warnings - a.warnings ||
          b.total - a.total ||
          a.service.localeCompare(b.service),
      );
  }

  // -------------------------------------------------------------------------
  // Waiting for new data
  // -------------------------------------------------------------------------

  /** Resolves true when new entries arrive (or on reset), false after `timeoutMs`. */
  waitForIngest(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wake = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  get waiting() {
    return this.waiters.size;
  }

  private wake() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const w of waiters) w();
  }

  private evict() {
    // Evict in chunks so the splice cost is amortized.
    const overflow = this.recs.length - this.capacity;
    if (overflow <= 0 || overflow < Math.max(1, Math.floor(this.capacity * 0.02))) return;
    const removed = this.recs.splice(0, overflow);
    for (const r of removed) this.byId.delete(r.e.insertId);
  }

  private trackRate(now: number, n: number) {
    const last = this.rateSamples[this.rateSamples.length - 1];
    const second = Math.floor(now / 1000) * 1000;
    if (last && last.t === second) last.n += n;
    else this.rateSamples.push({ t: second, n });
    if (this.rateSamples.length > 30) this.rateSamples.splice(0, this.rateSamples.length - 30);
  }
}

/** First index where `pred` is false, assuming pred is true for a prefix. */
function lowerBound<T>(items: T[], pred: (item: T) => boolean): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(items[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const severityAtLeast = (min: Severity): Predicate => {
  const rank = SEVERITY_RANK[min];
  return (e) => (SEVERITY_RANK[e.severity] ?? 0) >= rank;
};
