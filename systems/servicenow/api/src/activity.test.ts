import type { ActivityTailResult } from '@sim/contracts/servicenow';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

type App = ReturnType<typeof buildApp>['app'];
const tail = async (app: App, query: string) =>
  (await (await app.request(`/api/activity/tail?${query}`)).json()) as ActivityTailResult;

describe('activity feed', () => {
  it('lists journal entries of incidents and change requests in seq order', async () => {
    const { app } = buildApp();
    const head = await tail(app, 'limit=1');
    const start = head.last_seq;
    expect(start).toBeGreaterThan(0); // seeded history

    const created = await app.request(
      '/api/incidents',
      json({
        short_description: 'Banker cannot open customer profile',
        contact_type: 'phone',
        caller: 'svc_incident_auto',
      }),
    );
    const inc = (await created.json()) as { number: string };
    await app.request(
      `/api/incidents/${inc.number}`,
      json({ state: 'in_progress', work_note: 'Looking' }, 'PATCH'),
    );
    await app.request(
      `/api/incidents/${inc.number}/journal`,
      json({ type: 'comment', text: 'On it' }),
    );

    const r = await tail(app, `after_seq=${start}`);
    expect(r.items.map((e) => [e.kind, e.number])).toEqual([
      ['incident.opened', inc.number],
      ['incident.updated', inc.number],
      ['incident.work_note', inc.number],
      ['incident.comment', inc.number],
    ]);
    expect(r.items.map((e) => e.seq)).toEqual([...r.items.map((e) => e.seq)].sort((a, b) => a - b));
    expect(r.items[0]!.incident?.contact_type).toBe('phone');
    expect(r.items[0]!.incident?.state).toBe('in_progress'); // current snapshot
    expect(r.cursor).toBe(r.last_seq);
    expect(r.has_more).toBe(false);
  });

  it('filters by kind and contact type, and pages with has_more', async () => {
    const { app } = buildApp();
    const start = (await tail(app, 'limit=1')).last_seq;
    for (const contact_type of ['phone', 'email', 'phone']) {
      await app.request(
        '/api/incidents',
        json({ short_description: `Call ${contact_type}`, contact_type }),
      );
    }
    const phone = await tail(app, `after_seq=${start}&kind=incident.opened&contact_type=phone`);
    expect(phone.items.map((e) => e.incident?.short_description)).toEqual([
      'Call phone',
      'Call phone',
    ]);

    const page = await tail(app, `after_seq=${start}&limit=2`);
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(true);
    const rest = await tail(app, `after_seq=${page.cursor}`);
    expect(rest.items).toHaveLength(1);
  });

  it('long-polls until a write arrives', async () => {
    const { app } = buildApp();
    const start = (await tail(app, 'limit=1')).last_seq;
    const pending = tail(app, `after_seq=${start}&wait_seconds=5`);
    setTimeout(() => {
      void app.request('/api/incidents', json({ short_description: 'Late arrival' }));
    }, 50);
    const r = await pending;
    expect(r.items.map((e) => e.incident?.short_description)).toEqual(['Late arrival']);
  });

  it('changes epoch on reset', async () => {
    const { app } = buildApp();
    const before = await tail(app, 'limit=1');
    await app.request('/admin/reset', { method: 'POST' });
    const after = await tail(app, 'limit=1');
    expect(after.epoch).not.toBe(before.epoch);
  });

  it('streams events over SSE', async () => {
    const { app } = buildApp();
    const ac = new AbortController();
    const res = await app.request('/api/activity/stream?kind=incident.opened', {
      signal: ac.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await app.request('/api/incidents', json({ short_description: 'Streamed' }));
    let text = '';
    while (!text.includes('event: activity')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    ac.abort();
    await reader.cancel();
    expect(text).toMatch(/event: activity\ndata: .*"Streamed".*\nid: \d+/);
  });
});
