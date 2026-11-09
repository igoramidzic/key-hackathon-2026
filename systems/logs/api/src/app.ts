import { badRequest, createApi, paginate, parseBody, parseQuery, parseTime } from '@sim/api-kit';
import type { ResetResult } from '@sim/contracts';
import type {
  Alert,
  IngestResult,
  LogEntryInput,
  LogSearchResult,
  LogServicesResult,
  LogTailResult,
  Severity,
} from '@sim/contracts/logs';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AlertStore } from './alerts';
import {
  compileFilter,
  FilterSyntaxError,
  formatFilterError,
  type Predicate,
  textPredicate,
} from './query';
import {
  alertInputSchema,
  alertListSchema,
  alertUpdateSchema,
  ingestSchema,
  searchSchema,
  streamSchema,
  summarySchema,
  tailSchema,
  windowSchema,
} from './schemas';
import { LogStore, severityAtLeast, type Window } from './store';

export const SERVICE = 'logs-api';
const MIN = 60_000;
const HEARTBEAT_MS = 15_000;

interface FilterParams {
  filter?: string;
  severity?: Severity;
  app_tla?: string[];
  service?: string[];
  q?: string;
  since?: string;
  until?: string;
}

/** Combines the query-language filter and convenience params into one predicate. */
export function buildPredicate(p: FilterParams): Predicate {
  const preds: Predicate[] = [];
  if (p.filter?.trim()) {
    try {
      preds.push(compileFilter(p.filter));
    } catch (err) {
      if (err instanceof FilterSyntaxError) throw badRequest(formatFilterError(p.filter, err));
      throw err;
    }
  }
  if (p.severity) preds.push(severityAtLeast(p.severity));
  if (p.app_tla?.length) {
    const set = new Set(p.app_tla.map((t) => t.toUpperCase()));
    preds.push((e) => set.has((e.labels?.app_tla ?? '').toUpperCase()));
  }
  if (p.service?.length) {
    const set = new Set(p.service.map((s) => s.toLowerCase()));
    preds.push((e) => set.has((e.resource?.labels?.container_name ?? '').toLowerCase()));
  }
  if (p.q?.trim()) preds.push(textPredicate(p.q.trim()));
  if (preds.length === 0) return () => true;
  if (preds.length === 1) return preds[0]!;
  return (e) => {
    for (const pred of preds) if (!pred(e)) return false;
    return true;
  };
}

function timeWindow(
  p: FilterParams,
  defaults: { sinceMs?: number; untilNow?: boolean },
  now = new Date(),
): { since?: number; until?: number } {
  const since =
    parseTime(p.since, now)?.getTime() ??
    (defaults.sinceMs !== undefined ? now.getTime() - defaults.sinceMs : undefined);
  const until =
    parseTime(p.until, now)?.getTime() ?? (defaults.untilNow ? now.getTime() : undefined);
  if (since !== undefined && until !== undefined && until < since) {
    throw badRequest('`until` must be after `since`');
  }
  return { since, until };
}

const parseId = (c: Context) => {
  const raw = c.req.param('id') ?? '';
  if (!/^\d+$/.test(raw)) throw badRequest(`Invalid alert id: ${raw}`);
  return Number(raw);
};

export function createLogsApp(opts: { capacity?: number } = {}) {
  const logs = new LogStore(opts.capacity);
  const alerts = new AlertStore();
  let subscribers = 0;

  const app = createApi({
    service: SERVICE,
    stats: () => ({
      entries: logs.size,
      last_seq: logs.lastSeq,
      alerts_open: alerts.openCount,
      alerts_total: alerts.total,
      ingest_per_sec: logs.ingestPerSec(),
      stream_subscribers: subscribers,
    }),
  });

  app.post('/admin/reset', (c) => {
    logs.clear();
    alerts.reset();
    return c.json<ResetResult>({ ok: true, service: SERVICE, reset_at: new Date().toISOString() });
  });

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------

  app.post('/api/logs/ingest', async (c) => {
    const body = await parseBody(c, ingestSchema);
    const accepted = logs.ingest(body.entries as unknown as LogEntryInput[]);
    return c.json<IngestResult>({ accepted, last_seq: logs.lastSeq });
  });

  app.get('/api/logs', (c) => {
    const p = parseQuery(c, searchSchema);
    const pred = buildPredicate(p);
    const win: Window = {
      ...timeWindow(p, { sinceMs: p.after_seq === undefined ? 60 * MIN : undefined }),
      afterSeq: p.after_seq,
    };
    const page = logs.search(pred, win, { order: p.order, limit: p.limit, cursor: p.cursor });
    return c.json<LogSearchResult>({ ...page, last_seq: logs.lastSeq });
  });

  app.get('/api/logs/entries/:insertId', (c) => {
    const id = c.req.param('insertId');
    const entry = logs.get(id);
    if (!entry) return c.json({ error: `Log entry ${id} not found (it may have aged out)` }, 404);
    return c.json(entry);
  });

  app.get('/api/logs/tail', async (c) => {
    const p = parseQuery(c, tailSchema);
    const pred = buildPredicate(p);
    const win = timeWindow(p, {});
    if (p.after_seq === undefined) {
      const items = logs.latest(pred, p.limit, win);
      return c.json<LogTailResult>({
        items,
        cursor: logs.lastSeq,
        last_seq: logs.lastSeq,
        has_more: false,
      });
    }
    const deadline = Date.now() + p.wait_seconds * 1000;
    const signal = c.req.raw.signal;
    let after = p.after_seq;
    for (;;) {
      const r = logs.readAfter(after, pred, p.limit, win);
      after = r.cursor;
      const remaining = deadline - Date.now();
      if (r.items.length > 0 || remaining <= 0 || signal.aborted) {
        return c.json<LogTailResult>({
          items: r.items,
          cursor: r.cursor,
          last_seq: logs.lastSeq,
          has_more: r.hasMore,
        });
      }
      await logs.waitForIngest(remaining, signal);
    }
  });

  app.get('/api/logs/stream', (c) => {
    const p = parseQuery(c, streamSchema);
    const pred = buildPredicate(p);
    const win = timeWindow(p, {});
    const lastEventId = c.req.header('Last-Event-ID');
    let after =
      lastEventId && /^\d+$/.test(lastEventId)
        ? Number(lastEventId)
        : (p.after_seq ?? logs.lastSeq);
    const reqSignal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      const abort = () => ac.abort();
      stream.onAbort(abort);
      reqSignal.addEventListener('abort', abort, { once: true });
      subscribers++;
      try {
        let epoch = logs.epoch;
        // Reconnect hint + a comment so proxies flush headers immediately.
        await stream.write(`retry: 2000\n: connected last_seq=${logs.lastSeq}\n\n`);
        let lastWrite = Date.now();
        while (!ac.signal.aborted && !stream.aborted && !stream.closed) {
          if (logs.epoch !== epoch) {
            epoch = logs.epoch;
            await stream.writeSSE({ event: 'reset', data: JSON.stringify({ reset: true }) });
            lastWrite = Date.now();
          }
          const r = logs.readAfter(after, pred, 500, win);
          after = r.cursor;
          for (const entry of r.items) {
            if (ac.signal.aborted) break;
            await stream.writeSSE({
              id: String(entry.seq),
              event: 'log',
              data: JSON.stringify(entry),
            });
          }
          if (r.items.length > 0) lastWrite = Date.now();
          if (r.hasMore) continue;
          const idleFor = Date.now() - lastWrite;
          const woke = await logs.waitForIngest(Math.max(250, HEARTBEAT_MS - idleFor), ac.signal);
          if (!woke && !ac.signal.aborted && Date.now() - lastWrite >= HEARTBEAT_MS - 250) {
            await stream.write(': heartbeat\n\n');
            lastWrite = Date.now();
          }
        }
      } finally {
        subscribers--;
        reqSignal.removeEventListener('abort', abort);
      }
    });
  });

  app.get('/api/logs/histogram', (c) => {
    const p = parseQuery(c, windowSchema);
    const pred = buildPredicate(p);
    const { since, until } = timeWindow(p, { sinceMs: 60 * MIN, untilNow: true });
    return c.json(logs.histogram(pred, since!, until!));
  });

  app.get('/api/logs/summary', (c) => {
    const p = parseQuery(c, summarySchema);
    const pred = buildPredicate({ ...p, severity: p.severity ?? 'WARNING' });
    const { since, until } = timeWindow(p, { sinceMs: 30 * MIN, untilNow: true });
    return c.json(logs.summary(pred, since!, until!, p.limit));
  });

  app.get('/api/logs/services', (c) => {
    const p = parseQuery(c, windowSchema);
    const pred = buildPredicate(p);
    const { since, until } = timeWindow(p, { sinceMs: 60 * MIN, untilNow: true });
    return c.json<LogServicesResult>({
      since: new Date(since!).toISOString(),
      until: new Date(until!).toISOString(),
      items: logs.services(pred, since!, until!),
    });
  });

  // -------------------------------------------------------------------------
  // Moogsoft alerts
  // -------------------------------------------------------------------------

  app.post('/api/alerts', async (c) => {
    const body = await parseBody(c, alertInputSchema);
    const { alert, created } = alerts.raise(body);
    return c.json<Alert>(alert, created ? 201 : 200);
  });

  app.get('/api/alerts', (c) => {
    const p = parseQuery(c, alertListSchema);
    const items = alerts.list({ ...p, since: parseTime(p.since) });
    return c.json(paginate(items, { limit: p.limit, cursor: p.cursor }));
  });

  app.get('/api/alerts/:id', (c) => c.json<Alert>(alerts.get(parseId(c))));

  app.patch('/api/alerts/:id', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, alertUpdateSchema);
    return c.json<Alert>(alerts.update(id, body));
  });

  return { app, logs, alerts };
}
