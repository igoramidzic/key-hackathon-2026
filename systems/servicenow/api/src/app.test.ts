import type { Page } from '@sim/contracts';
import type { Incident, IncidentSummary } from '@sim/contracts/servicenow';
import { priorityFor } from '@sim/contracts/servicenow';
import { HERO_TLAS, PAST_MAJOR_INCIDENTS } from '@sim/world';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('priority matrix', () => {
  it('matches the standard ServiceNow matrix', () => {
    expect(priorityFor(1, 1)).toBe(1);
    expect([priorityFor(1, 2), priorityFor(2, 1)]).toEqual([2, 2]);
    expect([priorityFor(1, 3), priorityFor(2, 2), priorityFor(3, 1)]).toEqual([3, 3, 3]);
    expect([priorityFor(2, 3), priorityFor(3, 2)]).toEqual([4, 4]);
    expect(priorityFor(3, 3)).toBe(5);
  });
});

describe('seed', () => {
  it('is deterministic and has ~12 open P3-P5 incidents', async () => {
    const a = buildApp();
    const b = buildApp();
    const list = async (app: typeof a.app) =>
      (await (
        await app.request('/api/incidents?limit=500&sort=number')
      ).json()) as Page<IncidentSummary>;
    const [la, lb] = await Promise.all([list(a.app), list(b.app)]);
    expect(la.total).toBe(203);
    expect(la.items.map((i) => i.short_description)).toEqual(
      lb.items.map((i) => i.short_description),
    );
    expect(la.items[0]!.number).toBe('INC0010001');
    expect(la.items.at(-1)!.number).toBe('INC0010203');
    const open = la.items.filter((i) => ['new', 'in_progress', 'on_hold'].includes(i.state));
    expect(open).toHaveLength(12);
    expect(open.every((i) => i.priority >= 3)).toBe(true);
    expect(open.some((i) => HERO_TLAS.includes(i.app!.tla))).toBe(false);
    // Numbers follow opened order. If this fails after a seed change, renumber
    // PAST_MAJOR_INCIDENTS in @sim/world so they land in opened order again.
    const byOpened = [...la.items].sort((x, y) => x.opened_at.localeCompare(y.opened_at));
    expect(byOpened.map((i) => i.number)).toEqual(la.items.map((i) => i.number));
  });

  it('includes the past major incidents', async () => {
    const { app } = buildApp();
    for (const inc of PAST_MAJOR_INCIDENTS) {
      const res = await app.request(`/api/incidents/${inc.number}`);
      expect(res.status).toBe(200);
      const rec = (await res.json()) as Incident;
      expect(rec.app!.tla).toBe(inc.tla);
      expect(`P${rec.priority}`).toBe(inc.priority);
      expect(['resolved', 'closed']).toContain(rec.state);
      expect(rec.close_code).toBe(inc.closeCode);
      expect(rec.links.some((l) => l.type === 'teams_channel')).toBe(false);
    }
  });
});

describe('incident lifecycle', () => {
  it('creates, updates and resolves with journal entries', async () => {
    const { app } = buildApp();
    const created = (await (
      await app.request(
        '/api/incidents',
        json({ short_description: 'PAY errors', app_tla: 'pay', impact: 1, urgency: 2 }),
      )
    ).json()) as Incident;
    expect(created.number).toBe('INC0010204');
    expect(created.priority).toBe(2);
    expect(created.opened_by.username).toBe('svc_incident_auto');
    expect(created.contact_type).toBe('monitoring');

    const patch = (body: unknown) =>
      app.request(`/api/incidents/${created.number}`, { ...json(body), method: 'PATCH' });

    const updated = (await (
      await patch({
        state: 'in_progress',
        assignment_group: 'grp_pay_support',
        work_note: 'Looking',
        add_links: [
          { type: 'teams_channel', url: 'http://localhost:3004/channels/c1', title: '#inc' },
        ],
      })
    ).json()) as Incident;
    expect(updated.state).toBe('in_progress');
    expect(updated.links).toHaveLength(1);
    const system = updated.journal.filter((j) => j.type === 'system').at(-1)!;
    expect(system.text).toContain('State changed from New to In Progress');

    expect((await patch({ state: 'resolved' })).status).toBe(400);
    const resolved = (await (
      await patch({
        state: 'resolved',
        close_code: 'Resolved by change',
        close_notes: 'Reverted MR',
      })
    ).json()) as Incident;
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Parent / child incidents
// ---------------------------------------------------------------------------

function client(app: ReturnType<typeof buildApp>['app']) {
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  };
}

const call = (caller: string, desc: string) => ({
  short_description: desc,
  caller,
  opened_by: 'pnatarajan',
  contact_type: 'phone',
  impact: 2,
  urgency: 2,
  assignment_group: 'grp_service_desk',
});

describe('parent and child incidents', () => {
  it('groups callers under a parent, copies comments and resolves the children', async () => {
    const { app } = buildApp();
    const api = client(app);
    const a = (await api.post<Incident>('/api/incidents', call('mlopez', 'Teller dates wrong')))
      .body;
    const b = (await api.post<Incident>('/api/incidents', call('kbrandt', 'Drawer out of balance')))
      .body;

    const standalone = (
      await api.get<Page<IncidentSummary>>(
        '/api/incidents?active=true&contact_type=phone&relationship=standalone',
      )
    ).body;
    expect(standalone.items.map((i) => i.number)).toEqual(
      expect.arrayContaining([a.number, b.number]),
    );

    const parent = (
      await api.post<Incident>('/api/incidents', {
        short_description: 'TLR posting with next business date',
        app_tla: 'TLR',
        impact: 1,
        urgency: 2,
        child_incidents: [a.number, b.number],
      })
    ).body;
    expect(parent.child_incidents.map((c) => c.number)).toEqual([a.number, b.number]);
    expect(parent.journal.at(-1)!.text).toContain(
      `Child incidents added: ${a.number}, ${b.number}`,
    );

    const child = (await api.get<Incident>(`/api/incidents/${a.number}`)).body;
    expect(child.parent_incident).toBe(parent.number);
    expect(child.journal.at(-1)!.text).toContain(
      `Parent Incident changed from (empty) to ${parent.number}`,
    );

    // One level only.
    const c = (await api.post<Incident>('/api/incidents', call('mlopez', 'Another call'))).body;
    expect(
      (await api.patch(`/api/incidents/${parent.number}`, { parent_incident: c.number })).status,
    ).toBe(409);
    expect(
      (await api.patch(`/api/incidents/${c.number}`, { parent_incident: a.number })).status,
    ).toBe(409);
    const linked = await api.post<Incident>(`/api/incidents/${parent.number}/children`, {
      children: [c.number, a.number],
      child_comment: `Known issue, tracked in ${parent.number}.`,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.child_incidents).toHaveLength(3);

    const children = (
      await api.get<Page<IncidentSummary>>(`/api/incidents?parent_incident=${parent.number}`)
    ).body;
    expect(children.total).toBe(3);
    const parentRow = (
      await api.get<Page<IncidentSummary>>('/api/incidents?relationship=parent')
    ).body.items.find((i) => i.number === parent.number);
    expect(parentRow?.child_count).toBe(3);

    await api.patch(`/api/incidents/${parent.number}`, {
      comment: 'Fix is being deployed.',
      state: 'resolved',
      close_code: 'Resolved by change',
      close_notes: 'Business date time zone restored.',
    });
    for (const n of [a.number, b.number, c.number]) {
      const kid = (await api.get<Incident>(`/api/incidents/${n}`)).body;
      expect(kid.state).toBe('resolved');
      expect(kid.close_notes).toContain(`Resolved with parent incident ${parent.number}`);
      expect(
        kid.journal.some((j) => j.type === 'comment' && j.text.includes('Fix is being deployed.')),
      ).toBe(true);
    }
    const resolvedParent = (await api.get<Incident>(`/api/incidents/${parent.number}`)).body;
    expect(resolvedParent.journal.at(-1)!.text).toContain('Resolved 3 child incidents');
    // A resolved parent takes no new children.
    const d = (await api.post<Incident>('/api/incidents', call('mlopez', 'Late call'))).body;
    expect(
      (await api.patch(`/api/incidents/${d.number}`, { parent_incident: parent.number })).status,
    ).toBe(409);
  });
});
