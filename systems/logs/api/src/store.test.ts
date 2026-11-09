import type { LogEntryInput, Severity } from '@sim/contracts/logs';
import { describe, expect, it } from 'vitest';
import { AlertStore, FIRST_ALERT_ID } from './alerts';
import { normalizeMessage } from './normalize';
import { compileFilter } from './query';
import { LogStore } from './store';

const all = () => true;

function input(
  i: number,
  ts: number,
  severity: Severity = 'INFO',
  service = 'payments-api',
  message = `request ${i} ok`,
): LogEntryInput {
  return {
    logName: 'projects/kb-prod-pay00/logs/stdout',
    timestamp: new Date(ts).toISOString(),
    severity,
    resource: {
      type: 'k8s_container',
      labels: {
        project_id: 'kb-prod-pay00',
        location: 'us-east4',
        cluster_name: 'gke',
        namespace_name: 'pay00',
        pod_name: 'pod',
        container_name: service,
      },
    },
    labels: { app_tla: 'PAY', app_name: 'Payments', env: 'prod', version: '1' },
    jsonPayload: { message },
  };
}

describe('normalizeMessage', () => {
  it.each([
    ['Timeout after 3000ms calling cif for C10458213', 'Timeout after <n>ms calling cif for C<n>'],
    ['Account ****4821 overdrawn by 1,284.50', 'Account <acct> overdrawn by <n>'],
    ['trace 4bf92f3577b34da6a3ce929d0e0e4736 failed', 'trace <hex> failed'],
    [
      'Order 123e4567-e89b-12d3-a456-426614174000 rejected: "insufficient funds"',
      'Order <uuid> rejected: "<str>"',
    ],
    ['Connection refused 10.2.3.4:5432\n  at Foo.bar()', 'Connection refused <ip>'],
  ])('%j', (message, pattern) => {
    expect(normalizeMessage(message)).toBe(pattern);
  });
});

describe('LogStore', () => {
  const t0 = Date.parse('2026-11-09T14:00:00Z');

  it('assigns seq, insertId and receiveTimestamp and dedupes insertIds', () => {
    const store = new LogStore();
    expect(store.ingest([input(1, t0), { ...input(2, t0), insertId: 'fixed' }])).toBe(2);
    expect(store.ingest([{ ...input(3, t0), insertId: 'fixed' }])).toBe(0);
    expect(store.lastSeq).toBe(2);
    const e = store.get('fixed')!;
    expect(e.seq).toBe(2);
    expect(e.receiveTimestamp).toBeTruthy();
  });

  it('orders search results by timestamp and paginates with a stable keyset cursor', () => {
    const store = new LogStore();
    // Arrive out of order (backfill).
    store.ingest([input(1, t0 + 3000), input(2, t0 + 1000), input(3, t0 + 2000)]);
    const page1 = store.search(all, {}, { order: 'desc', limit: 2 });
    expect(page1.items.map((e) => e.jsonPayload?.message)).toEqual([
      'request 1 ok',
      'request 3 ok',
    ]);
    expect(page1.total).toBe(3);
    // A newer entry arriving between pages must not shift page 2.
    store.ingest([input(4, t0 + 9000)]);
    const page2 = store.search(all, {}, { order: 'desc', limit: 2, cursor: page1.next_cursor! });
    expect(page2.items.map((e) => e.jsonPayload?.message)).toEqual(['request 2 ok']);
    expect(page2.next_cursor).toBeNull();

    const asc = store.search(all, {}, { order: 'asc', limit: 3 });
    expect(asc.items.map((e) => e.seq)).toEqual([2, 3, 1]);
  });

  it('applies time windows and afterSeq', () => {
    const store = new LogStore();
    store.ingest([input(1, t0), input(2, t0 + 60_000), input(3, t0 + 120_000)]);
    expect(store.search(all, { since: t0 + 30_000 }, { order: 'asc', limit: 10 }).total).toBe(2);
    expect(store.search(all, { afterSeq: 2 }, { order: 'asc', limit: 10 }).items[0]!.seq).toBe(3);
  });

  it('reads in arrival order after a cursor without rescanning non-matches', () => {
    const store = new LogStore();
    store.ingest([
      input(1, t0, 'ERROR'),
      input(2, t0, 'INFO'),
      input(3, t0, 'ERROR'),
      input(4, t0, 'INFO'),
    ]);
    const errors = compileFilter('severity>=ERROR');
    const r1 = store.readAfter(0, errors, 1);
    expect(r1.items.map((e) => e.seq)).toEqual([1]);
    expect(r1.hasMore).toBe(true);
    const r2 = store.readAfter(r1.cursor, errors, 10);
    expect(r2.items.map((e) => e.seq)).toEqual([3]);
    expect(r2.cursor).toBe(4);
    expect(store.readAfter(r2.cursor, errors, 10).items).toEqual([]);
    // A cursor from before a restart is clamped instead of hiding new entries.
    expect(store.readAfter(999, all, 10).cursor).toBe(4);
  });

  it('evicts the oldest entries beyond capacity', () => {
    const store = new LogStore(100);
    store.ingest(Array.from({ length: 150 }, (_, i) => input(i, t0 + i)));
    expect(store.size).toBe(100);
    expect(store.search(all, {}, { order: 'asc', limit: 1 }).items[0]!.seq).toBe(51);
  });

  it('builds histograms with ~60 or fewer aligned buckets', () => {
    const store = new LogStore();
    store.ingest([input(1, t0 + 5 * 60_000, 'ERROR'), input(2, t0 + 5 * 60_000 + 1, 'INFO')]);
    const h = store.histogram(all, t0, t0 + 3_600_000);
    expect(h.bucket_seconds).toBe(60);
    expect(h.buckets.length).toBe(60);
    expect(h.total).toBe(2);
    expect(h.buckets[5]).toMatchObject({ total: 2, counts: { ERROR: 1, INFO: 1 } });
  });

  it('summarizes error fingerprints', () => {
    const store = new LogStore();
    store.ingest([
      input(1, t0, 'ERROR', 'payments-api', 'Timeout after 3000ms for C1'),
      input(2, t0 + 1000, 'CRITICAL', 'payments-api', 'Timeout after 5000ms for C2'),
      input(3, t0 + 2000, 'ERROR', 'ach-api', 'Timeout after 3000ms for C1'),
      input(4, t0 + 3000, 'ERROR', 'payments-api', 'Timeout after 4000ms for C3'),
    ]);
    const s = store.summary(all, t0, t0 + 60_000, 10);
    expect(s.total_matched).toBe(4);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({
      service: 'payments-api',
      count: 3,
      severity: 'CRITICAL',
      pattern: 'Timeout after <n>ms for C<n>',
      first_seen: new Date(t0).toISOString(),
      last_seen: new Date(t0 + 3000).toISOString(),
      sample_message: 'Timeout after 4000ms for C3',
    });
  });

  it('computes per-service stats', () => {
    const store = new LogStore();
    store.ingest([
      input(1, t0, 'ERROR'),
      input(2, t0, 'INFO'),
      input(3, t0, 'WARNING'),
      input(4, t0, 'INFO', 'ach-api'),
    ]);
    const [pay, ach] = store.services(all, t0 - 1, t0 + 1);
    expect(pay).toMatchObject({ service: 'payments-api', total: 3, errors: 1, warnings: 1 });
    expect(pay!.error_rate).toBeCloseTo(0.3333, 3);
    expect(ach).toMatchObject({ service: 'ach-api', total: 1, errors: 0, last_error_at: null });
  });

  it('wakes waiters on ingest', async () => {
    const store = new LogStore();
    const waiting = store.waitForIngest(5000);
    store.ingest([input(1, t0)]);
    expect(await waiting).toBe(true);
    expect(await store.waitForIngest(10)).toBe(false);
  });
});

describe('AlertStore', () => {
  const base = {
    severity: 'major' as const,
    description: 'HTTP 5xx rate 12% on payments-api (threshold 5%)',
    source: 'payments-api-7d9f8-x2k4q',
    service: 'payments-api',
    app_tla: 'PAY',
    manager: 'AppDynamics' as const,
    class: 'Application',
    check: 'http_5xx_rate',
    dedupe_key: 'appd:payments-api:http_5xx_rate',
  };

  it('seeds deterministic background alerts', () => {
    const a = new AlertStore();
    const b = new AlertStore();
    const listA = a.list({});
    expect(listA.length).toBeGreaterThanOrEqual(12);
    expect(listA.map((x) => [x.id, x.description])).toEqual(
      b.list({}).map((x) => [x.id, x.description]),
    );
    expect(Math.min(...listA.map((x) => x.id))).toBe(FIRST_ALERT_ID);
    expect(a.openCount).toBeGreaterThanOrEqual(2);
    expect(listA.every((x) => x.web_url === `http://localhost:3001/alerts/${x.id}`)).toBe(true);
  });

  it('dedupes open alerts and creates new ones after resolution', () => {
    const store = new AlertStore();
    const { alert, created } = store.raise(base);
    expect(created).toBe(true);
    const bump = store.raise({ ...base, severity: 'critical', description: 'HTTP 5xx rate 40%' });
    expect(bump.created).toBe(false);
    expect(bump.alert.id).toBe(alert.id);
    expect(bump.alert).toMatchObject({ event_count: 2, severity: 'critical' });

    store.update(alert.id, { status: 'acknowledged', owner: 'mbell' });
    expect(store.raise(base).alert.event_count).toBe(3);

    store.update(alert.id, { status: 'resolved', note: { author: 'mbell', text: 'fixed' } });
    expect(store.get(alert.id).notes.at(-1)).toMatchObject({ author: 'mbell', text: 'fixed' });
    const fresh = store.raise(base);
    expect(fresh.created).toBe(true);
    expect(fresh.alert.id).toBe(alert.id + 1);
  });

  it('filters and sorts by last event time', () => {
    const store = new AlertStore();
    store.raise(base);
    const open = store.list({ status: ['open', 'acknowledged'] });
    expect(open[0]!.service).toBe('payments-api');
    expect(store.list({ app_tla: ['pay'], q: '5xx' })).toHaveLength(1);
  });
});
