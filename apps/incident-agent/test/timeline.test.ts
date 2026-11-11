import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CaseStore } from '../src/cases/store';
import type { Case } from '../src/cases/types';
import { silent } from '../src/log';
import {
  startTimelineServer,
  type TimelineServer,
  type TimelineServerOptions,
} from '../src/timeline/server';
import type { CaseSummary, CaseView } from '../src/timeline/view';
import { readSse, type SseEvent } from '../src/watchers/sse';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'agent-timeline-'));
const WEB = { servicenow: 'http://sn.test', gitlab: 'http://gl.test', logs: 'http://logs.test' };

let servers: TimelineServer[] = [];
const streams: AbortController[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(store: CaseStore, extra: Partial<TimelineServerOptions> = {}) {
  const server = await startTimelineServer(store, { port: 0, log: silent, web: WEB, ...extra });
  servers.push(server);
  return server;
}

function seed(store: CaseStore): Case {
  const c = store.create({ kind: 'monitoring', apps: ['CIF', 'OLB'] });
  c.incident = {
    number: 'INC0010001',
    web_url: 'http://sn.test/incident/INC0010001',
    app_tla: 'CIF',
    assignment_group: null,
    priority: 2,
  };
  c.channel = { id: 'ch_1', name: 'inc0010001-lookups', web_url: 'http://teams.test/ch_1' };
  c.suspects = [
    {
      tla: 'CIF',
      change_request: { number: 'CHG0030001', web_url: 'http://sn.test/change/CHG0030001' },
      merge_request: {
        project: 'keybank/CIF00/customer-api',
        iid: 7,
        title: 'Rename profile fields',
        web_url: 'http://gl.test/keybank/CIF00/customer-api/-/merge_requests/7',
      },
      promoted_at: '2026-11-11T19:10:00Z',
      author: 'jdoe',
      reason: 'CHG0030001 promoted 4 minutes before the onset',
      confidence: 0.7,
    },
  ];
  c.background.deep_rca = {
    state: 'running',
    started_at: '2026-11-11T19:15:00Z',
    finished_at: null,
    error: null,
    runs: 1,
  };
  store.setPhase(c, 'declared', 'P2');
  return c;
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

/** Opens the SSE stream and returns a reader that waits for a matching event. */
async function subscribe(url: string) {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(`${url}/api/stream`, { signal: controller.signal });
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const events = readSse(res.body!, controller.signal);
  return async (name: string, match: (data: never) => boolean = () => true) => {
    for (;;) {
      const { value, done } = await events.next();
      if (done) throw new Error(`stream ended before a ${name} event`);
      const ev = value as SseEvent;
      if (ev.event === name && match(JSON.parse(ev.data) as never)) return JSON.parse(ev.data);
    }
  };
}

describe('timeline server', () => {
  it('lists case summaries, open cases first', async () => {
    const store = new CaseStore(tmp());
    const closed = store.create({ kind: 'monitoring', apps: ['PAY'] });
    store.setPhase(closed, 'resolved');
    const c = seed(store);
    const server = await start(store);

    const { status, body } = await getJson<{ cases: CaseSummary[] }>(`${server.url}/api/cases`);
    expect(status).toBe(200);
    expect(body.cases.map((x) => x.id)).toEqual([c.id, closed.id]);
    const [open] = body.cases;
    expect(open).toMatchObject({ phase: 'declared', open: true, apps: ['CIF', 'OLB'] });
    expect(open!.hypothesis).toMatchObject({ source: 'suspect', tla: 'CIF', confidence: 0.7 });
    expect(open!.background.map((t) => t.name)).toEqual(['deep_rca']);
    expect(open!.links).toContainEqual({
      label: 'INC0010001',
      url: 'http://sn.test/incident/INC0010001',
      system: 'servicenow',
    });
    expect(open!.stages.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(body.cases[1]).toMatchObject({ open: false, phase: 'resolved' });
  });

  it('returns one full case by id or incident number', async () => {
    const store = new CaseStore(tmp());
    const c = seed(store);
    const server = await start(store);

    const byId = await getJson<Case>(`${server.url}/api/cases/${c.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(c.id);
    expect(byId.body.timeline.length).toBe(c.timeline.length);
    expect(byId.body.correlation_id).toBe(c.correlation_id);

    const byIncident = await getJson<Case>(`${server.url}/api/cases/INC0010001`);
    expect(byIncident.body.id).toBe(c.id);

    expect((await fetch(`${server.url}/api/cases/case-nope`)).status).toBe(404);
  });

  it('serves the page with the @sim/ui theme inlined', async () => {
    const server = await start(new CaseStore(tmp()));
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('--background:');
    expect(html).toContain("new EventSource('api/stream')");
    expect(html).toContain('href="http://gl.test"');
  });

  it('streams a snapshot, then every change to a case', async () => {
    const store = new CaseStore(tmp());
    const c = seed(store);
    const server = await start(store, { heartbeatMs: 50 });
    const next = await subscribe(server.url);

    const snapshot = (await next('snapshot')) as { cases: CaseView[] };
    expect(snapshot.cases.map((x) => x.id)).toEqual([c.id]);
    expect(snapshot.cases[0]!.refs).toContainEqual([
      'keybank/CIF00/customer-api!7',
      'http://gl.test/keybank/CIF00/customer-api/-/merge_requests/7',
    ]);
    await next('ping');

    store.event(c, 'decision', 'Root cause: CIF CHG0030001', {
      url: 'http://sn.test/change/CHG0030001',
      data: { log_links: [{ label: 'CIF errors', logs_url: 'http://logs.test/?q=cif' }] },
    });
    const update = (await next('case', (v: CaseView) => v.id === c.id)) as CaseView;
    const last = update.timeline.at(-1)!;
    expect(last.text).toBe('Root cause: CIF CHG0030001');
    expect(last.links).toEqual([
      { label: 'CHG0030001', url: 'http://sn.test/change/CHG0030001', system: 'servicenow' },
      { label: 'CIF errors', url: 'http://logs.test/?q=cif', system: 'logs' },
    ]);
  });

  it('follows a store another process writes when serving from disk', async () => {
    const dir = tmp();
    const agent = new CaseStore(dir);
    const c = seed(agent);
    const server = await start(new CaseStore(dir), { fromDisk: true, pollMs: 50 });
    const next = await subscribe(server.url);

    expect(((await next('snapshot')) as { cases: CaseView[] }).cases[0]!.id).toBe(c.id);
    agent.setPhase(c, 'assembled', 'channel created');
    const update = (await next('case', (v: CaseView) => v.phase === 'assembled')) as CaseView;
    expect(update.timeline.at(-1)!.text).toContain('declared → assembled');

    const fresh = agent.create({ kind: 'human-reported' });
    expect(((await next('case', (v: CaseView) => v.id === fresh.id)) as CaseView).open).toBe(true);
  });
});
