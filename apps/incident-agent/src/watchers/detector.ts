/**
 * Error-spike detection over the live log stream. Pure and deterministic: time comes from the
 * entries themselves, so recorded fixtures replay exactly.
 *
 * Per (app, service) it keeps a rolling window of WARNING+ entries and fires a Signal when
 *  - spike:          the bad rate (ERROR+ or HTTP 5xx) exceeds max(k × baseline, floor) per minute
 *                    and stays there for `sustainSec`;
 *  - new_error_type: an error type never seen for that app shows up `newTypeMin` times in the
 *                    window (failures that don't raise the overall rate much);
 *  - warning_spike:  WARNING-only rise above max(k × baseline, warnFloor), emitted as `weak`.
 * Background errors never stop, so the baseline is learned (from recent history at start) and
 * slowly updated afterwards while the key is quiet.
 */
import type { LogEntry } from '@sim/contracts/logs';
import type { LogSignal } from '../cases/types';

export interface DetectConfig {
  windowSec: number;
  k: number;
  floorPerMin: number;
  warnFloorPerMin: number;
  sustainSec: number;
  newTypeMin: number;
  /** Quiet period per (key, reason) after firing. */
  cooldownSec?: number;
  /** EWMA weight for each closed minute. */
  alpha?: number;
}

/** The fields detection needs (also the fixture format). */
export interface MiniEntry {
  seq: number;
  insertId: string;
  timestamp: string;
  severity: string;
  app_tla: string;
  service: string;
  error_type?: string;
  status?: number;
  trace?: string;
  message: string;
}

const BAD_SEVERITIES = new Set(['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']);

export function toMini(e: LogEntry): MiniEntry {
  const mini: MiniEntry = {
    seq: e.seq,
    insertId: e.insertId,
    timestamp: e.timestamp,
    severity: e.severity,
    app_tla: e.labels?.app_tla ?? '?',
    service: e.resource?.labels?.container_name ?? '?',
    message: (e.jsonPayload?.message ?? e.textPayload ?? '').slice(0, 300),
  };
  const type = e.jsonPayload?.error?.type;
  if (type) mini.error_type = type;
  if (e.httpRequest?.status) mini.status = e.httpRequest.status;
  if (e.trace) mini.trace = e.trace;
  return mini;
}

export const isBad = (e: MiniEntry) =>
  BAD_SEVERITIES.has(e.severity) || (e.status !== undefined && e.status >= 500);
export const isWarning = (e: MiniEntry) => e.severity === 'WARNING' && !isBad(e);

interface Event {
  t: number;
  entry: MiniEntry;
}

interface KeyState {
  app: string;
  service: string;
  events: Event[];
  baseBad: number;
  baseWarn: number;
  /** Counts in the minute being accumulated for the baseline. */
  minuteBad: number;
  minuteWarn: number;
  pending: Partial<Record<LogSignal['reason'], number>>;
  quietUntil: Partial<Record<string, number>>;
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class SpikeDetector {
  private readonly keys = new Map<string, KeyState>();
  private readonly knownTypes = new Map<string, Set<string>>();
  private clock = 0;
  private minuteStart = 0;
  private signalSeq = 0;
  readonly cfg: Required<DetectConfig>;

  constructor(cfg: DetectConfig) {
    this.cfg = { cooldownSec: 600, alpha: 0.05, ...cfg };
  }

  private key(e: MiniEntry): KeyState {
    const id = `${e.app_tla}/${e.service}`;
    let s = this.keys.get(id);
    if (!s) {
      s = {
        app: e.app_tla,
        service: e.service,
        events: [],
        baseBad: 0,
        baseWarn: 0,
        minuteBad: 0,
        minuteWarn: 0,
        pending: {},
        quietUntil: {},
      };
      this.keys.set(id, s);
    }
    return s;
  }

  private known(app: string): Set<string> {
    let set = this.knownTypes.get(app);
    if (!set) {
      set = new Set();
      this.knownTypes.set(app, set);
    }
    return set;
  }

  /**
   * Learns the baseline from history (oldest first): per-key per-minute rates over the span,
   * and every error type each app already produces.
   */
  learn(entries: MiniEntry[]): void {
    if (entries.length === 0) return;
    const times = entries.map((e) => Date.parse(e.timestamp));
    const spanMin = Math.max(1, (Math.max(...times) - Math.min(...times)) / 60_000);
    const counts = new Map<KeyState, { bad: number; warn: number }>();
    for (const e of entries) {
      const s = this.key(e);
      const c = counts.get(s) ?? { bad: 0, warn: 0 };
      if (isBad(e)) c.bad++;
      else if (isWarning(e)) c.warn++;
      counts.set(s, c);
      if (e.error_type) this.known(e.app_tla).add(e.error_type);
    }
    for (const [s, c] of counts) {
      s.baseBad = c.bad / spanMin;
      s.baseWarn = c.warn / spanMin;
    }
  }

  baseline(app: string, service: string): { bad: number; warn: number } | undefined {
    const s = this.keys.get(`${app}/${service}`);
    return s && { bad: s.baseBad, warn: s.baseWarn };
  }

  /** Feeds one entry; returns any signals that fire. */
  ingest(entry: MiniEntry): LogSignal[] {
    const t = Date.parse(entry.timestamp);
    if (!Number.isFinite(t)) return [];
    this.advance(Math.max(this.clock, t));
    const s = this.key(entry);
    s.events.push({ t, entry });
    if (isBad(entry)) s.minuteBad++;
    else if (isWarning(entry)) s.minuteWarn++;
    return this.evaluate(s);
  }

  /** Re-evaluates pending keys at `now` (call periodically when the stream is quiet). */
  tick(now: number): LogSignal[] {
    if (now <= this.clock) return [];
    this.advance(now);
    const out: LogSignal[] = [];
    for (const s of this.keys.values())
      if (Object.keys(s.pending).length) out.push(...this.evaluate(s));
    return out;
  }

  private advance(now: number): void {
    if (this.minuteStart === 0) this.minuteStart = now;
    // Close whole minutes for the baseline EWMA (quiet keys only).
    while (now - this.minuteStart >= 60_000) {
      const a = this.cfg.alpha;
      for (const s of this.keys.values()) {
        const alarming =
          Object.keys(s.pending).length > 0 ||
          Object.values(s.quietUntil).some((u) => (u ?? 0) > this.minuteStart);
        if (!alarming) {
          s.baseBad = (1 - a) * s.baseBad + a * s.minuteBad;
          s.baseWarn = (1 - a) * s.baseWarn + a * s.minuteWarn;
        }
        s.minuteBad = 0;
        s.minuteWarn = 0;
      }
      this.minuteStart += 60_000;
    }
    this.clock = now;
  }

  private evaluate(s: KeyState): LogSignal[] {
    const now = this.clock;
    const windowMs = this.cfg.windowSec * 1000;
    while (s.events.length && s.events[0]!.t < now - windowMs) s.events.shift();
    const perMin = 60 / this.cfg.windowSec;
    const bad = s.events.filter((e) => isBad(e.entry));
    const warn = s.events.filter((e) => isWarning(e.entry));
    const badRate = bad.length * perMin;
    const warnRate = warn.length * perMin;
    const out: LogSignal[] = [];

    const spikeThreshold = Math.max(this.cfg.k * s.baseBad, this.cfg.floorPerMin);
    if (this.check(s, 'spike', badRate >= spikeThreshold)) {
      out.push(this.signal(s, 'spike', bad, badRate, s.baseBad));
    }

    // New error types for the app.
    const known = this.known(s.app);
    const fresh = new Map<string, Event[]>();
    for (const e of bad) {
      const type = e.entry.error_type;
      if (!type || known.has(type)) continue;
      const list = fresh.get(type) ?? [];
      list.push(e);
      fresh.set(type, list);
    }
    for (const [type, events] of fresh) {
      if (events.length < this.cfg.newTypeMin) continue;
      known.add(type);
      if ((s.quietUntil.spike ?? 0) > now) continue; // already reported as a spike
      if ((s.quietUntil[`type:${type}`] ?? 0) > now) continue;
      s.quietUntil[`type:${type}`] = now + this.cfg.cooldownSec * 1000;
      out.push(this.signal(s, 'new_error_type', events, events.length * perMin, 0, type));
    }

    const warnThreshold = Math.max(this.cfg.k * s.baseWarn, this.cfg.warnFloorPerMin);
    if (this.check(s, 'warning_spike', warnRate >= warnThreshold && badRate < spikeThreshold)) {
      out.push(this.signal(s, 'warning_spike', warn, warnRate, s.baseWarn));
    }
    return out;
  }

  /** Sustain + cooldown bookkeeping. True when the reason should fire now. */
  private check(s: KeyState, reason: LogSignal['reason'], over: boolean): boolean {
    const now = this.clock;
    if (!over) {
      delete s.pending[reason];
      return false;
    }
    if ((s.quietUntil[reason] ?? 0) > now) return false;
    const since = s.pending[reason] ?? now;
    s.pending[reason] = since;
    if (now - since < this.cfg.sustainSec * 1000) return false;
    delete s.pending[reason];
    s.quietUntil[reason] = now + this.cfg.cooldownSec * 1000;
    return true;
  }

  private signal(
    s: KeyState,
    reason: LogSignal['reason'],
    events: Event[],
    rate: number,
    baseline: number,
    onlyType?: string,
  ): LogSignal {
    const types = new Map<string, number>();
    for (const e of events) {
      const ty = e.entry.error_type;
      if (ty) types.set(ty, (types.get(ty) ?? 0) + 1);
    }
    const errorTypes = [...types.entries()].sort((a, b) => b[1] - a[1]).map(([ty]) => ty);
    const messages = [...new Set(events.map((e) => e.entry.message))].slice(0, 3);
    const traces = [
      ...new Set(events.map((e) => e.entry.trace).filter((x): x is string => Boolean(x))),
    ].slice(-5);
    const severity = reason === 'warning_spike' ? 'severity=WARNING' : 'severity>=ERROR';
    const clauses = [
      severity,
      `labels.app_tla=${quote(s.app)}`,
      `resource.labels.container_name=${quote(s.service)}`,
    ];
    if (onlyType) clauses.push(`jsonPayload.error.type=${quote(onlyType)}`);
    this.signalSeq++;
    return {
      source: 'logs',
      id: `log-${s.app}-${s.service}-${reason}-${this.clock}-${this.signalSeq}`,
      at: new Date(this.clock).toISOString(),
      app_tla: s.app,
      service: s.service,
      reason,
      strength: reason === 'warning_spike' ? 'weak' : 'strong',
      error_types: onlyType ? [onlyType] : errorTypes,
      first_seen: events[0]
        ? new Date(events[0].t).toISOString()
        : new Date(this.clock).toISOString(),
      count: events.length,
      rate: Math.round(rate * 10) / 10,
      baseline: Math.round(baseline * 100) / 100,
      sample_insert_ids: events.slice(-5).map((e) => e.entry.insertId),
      traces,
      sample_messages: messages,
      filter: clauses.join(' '),
    };
  }
}
