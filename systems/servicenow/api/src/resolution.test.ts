/**
 * What happens around and after the fix: the incident's Affected CIs and Resolution section,
 * problem records (the 8:00 AM stand-up) and Critical Incident Communications.
 */
import type { Page } from '@sim/contracts';
import type {
  ChangeRequest,
  Communication,
  CommunicationSummary,
  Incident,
  Problem,
  ProblemStandup,
  ProblemSummary,
} from '@sim/contracts/servicenow';
import { COMMUNICATION_FROM } from '@sim/contracts/servicenow';
import { getWorld, PAST_MAJOR_INCIDENTS, SHARED_GROUP_IDS } from '@sim/world';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { nextStandupDate, standupStartsAt, standupToday } from './problems';

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
    post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  };
}

const setup = () => {
  const built = buildApp();
  return { ...built, api: client(built.app) };
};

const mim = () => getWorld().groupsById.get(SHARED_GROUP_IDS.majorIncident)!.onCall;
const lastSystem = (i: Incident | Problem) => i.journal.filter((j) => j.type === 'system').at(-1)!;

describe('incident affected CIs and resolution section', () => {
  it('starts empty on seeded and new incidents', async () => {
    const { api } = setup();
    const seeded = (await api.get<Incident>('/api/incidents/INC0010001')).body;
    expect(seeded).toMatchObject({
      affected_cis: [],
      outage_start: null,
      service_restored_at: null,
      outage_duration_minutes: null,
      cause_code: null,
      caused_by_change: null,
      resolved_by_change: null,
      root_cause: null,
      client_impact: null,
      employee_impact: null,
      problem: null,
      communications: [],
    });
  });

  it('normalises affected CIs and records them when the incident is opened', async () => {
    const { api } = setup();
    const created = await api.post<Incident>('/api/incidents', {
      short_description: 'PAY errors',
      app_tla: 'PAY',
      affected_cis: ['ach', 'PAY', 'ACH', 'cif'],
      outage_start: '30m',
    });
    expect(created.status).toBe(201);
    const inc = created.body;
    // Upper case, no duplicates, never the incident's own application.
    expect(inc.affected_cis.map((a) => a.tla)).toEqual(['ACH', 'CIF']);
    expect(inc.affected_cis[0]!.name).toBeTruthy();
    const ago = Date.now() - Date.parse(inc.outage_start!);
    expect(ago).toBeGreaterThan(29 * 60_000);
    expect(ago).toBeLessThan(31 * 60_000);
    expect(inc.journal[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'affected_cis', label: 'Affected CIs', from: null, to: 'ACH, CIF' },
        { field: 'outage_start', label: 'Outage start', from: null, to: inc.outage_start },
      ]),
    );

    const bad = await api.post<{ error: string }>('/api/incidents', {
      short_description: 'x',
      affected_cis: ['ZZZ'],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Unknown affected_cis 'ZZZ'");

    // Re-pointing the incident at an affected CI takes that CI off the list.
    const moved = (await api.patch<Incident>(`/api/incidents/${inc.number}`, { app_tla: 'ACH' }))
      .body;
    expect(moved.affected_cis.map((a) => a.tla)).toEqual(['CIF']);
  });

  it('sets the resolution fields, journals each change and derives the outage duration', async () => {
    const { api } = setup();
    const inc = (
      await api.post<Incident>('/api/incidents', { short_description: 'CIF down', app_tla: 'CIF' })
    ).body;
    const patch = (body: unknown) => api.patch<Incident>(`/api/incidents/${inc.number}`, body);
    const rootCause = `A naming strategy change made every customer profile query fail. ${'Detail. '.repeat(40)}`;

    const unknown = await patch({ caused_by_change: 'CHG0039999' });
    expect(unknown.status).toBe(400);
    expect((unknown.body as unknown as { error: string }).error).toContain(
      "Unknown caused_by_change 'CHG0039999'",
    );
    const chg = (
      await api.post<ChangeRequest>('/api/change_requests', {
        short_description: 'Naming strategy',
        app_tla: 'CIF',
        merge_requests: ['keybank/CIF00/customer-profile-api!7'],
      })
    ).body;

    const updated = await patch({
      affected_cis: ['OLB', 'mbl'],
      outage_start: '2026-11-12T10:00:00Z',
      service_restored_at: '2026-11-12T10:47:20Z',
      cause_code: 'change',
      caused_by_change: chg.number.toLowerCase(),
      resolved_by_change: chg.number,
      root_cause: rootCause,
      client_impact: 'Customers could not open their profile in online banking.',
      employee_impact: 'Bankers could not look up customers.',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      outage_start: '2026-11-12T10:00:00.000Z',
      service_restored_at: '2026-11-12T10:47:20.000Z',
      outage_duration_minutes: 47,
      cause_code: 'Change',
      caused_by_change: chg.number,
      resolved_by_change: chg.number,
      root_cause: rootCause.trim(),
      client_impact: 'Customers could not open their profile in online banking.',
      employee_impact: 'Bankers could not look up customers.',
    });
    expect(updated.body.affected_cis.map((a) => a.tla)).toEqual(['OLB', 'MBL']);

    const entry = lastSystem(updated.body);
    expect(entry.text).toContain('Affected CIs changed from (empty) to OLB, MBL');
    expect(entry.text).toContain('Outage start changed from (empty) to 2026-11-12T10:00:00.000Z');
    expect(entry.text).toContain(
      'Service restored changed from (empty) to 2026-11-12T10:47:20.000Z',
    );
    expect(entry.text).toContain('Cause code changed from (empty) to Change');
    expect(entry.text).toContain(`Caused by change changed from (empty) to ${chg.number}`);
    expect(entry.text).toContain(`Resolved by change changed from (empty) to ${chg.number}`);
    expect(entry.text).toContain('Impact to clients set: Customers could not open');
    expect(entry.text).toContain('Impact to employees set: Bankers could not look up');
    // Long text is journaled as a one-line preview, not the whole paragraph.
    const line = entry.text.split('\n').find((l) => l.startsWith('Root cause set: '))!;
    expect(line.length).toBeLessThan(170);
    expect(entry.changes!.map((c) => c.label)).toEqual(
      expect.arrayContaining(['Root cause', 'Impact to clients', 'Impact to employees']),
    );

    // Same values again: nothing to record.
    const same = (await patch({ cause_code: 'Change', affected_cis: ['olb', 'MBL'] })).body;
    expect(same.journal).toHaveLength(updated.body.journal.length);

    // null clears; a restore time before the outage start is a duration of 0, not negative.
    const cleared = (await patch({ root_cause: null, caused_by_change: null, cause_code: null }))
      .body;
    expect(cleared).toMatchObject({ root_cause: null, caused_by_change: null, cause_code: null });
    expect(lastSystem(cleared).text).toContain('Root cause cleared');
    expect(
      (await patch({ service_restored_at: '2026-11-12T09:00:00Z' })).body.outage_duration_minutes,
    ).toBe(0);
    expect((await patch({ outage_start: null })).body.outage_duration_minutes).toBeNull();
    expect((await patch({ outage_start: 'yesterday-ish' })).status).toBe(400);
    expect((await patch({ cause_code: 'Gremlins' })).status).toBe(400);
  });

  it('resolves without the new fields, clears the restore time on reopen and keeps them off children', async () => {
    const { api } = setup();
    const child = (await api.post<Incident>('/api/incidents', { short_description: 'Caller' }))
      .body;
    const parent = (
      await api.post<Incident>('/api/incidents', {
        short_description: 'Outage',
        app_tla: 'TLR',
        child_incidents: [child.number],
      })
    ).body;
    const resolved = await api.patch<Incident>(`/api/incidents/${parent.number}`, {
      state: 'resolved',
      close_code: 'Solution provided',
      close_notes: 'Restarted.',
      service_restored_at: 'now',
      root_cause: 'Stuck consumer.',
      cause_code: 'Software defect',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.service_restored_at).not.toBeNull();
    const kid = (await api.get<Incident>(`/api/incidents/${child.number}`)).body;
    expect(kid.state).toBe('resolved');
    expect(kid).toMatchObject({ service_restored_at: null, root_cause: null, cause_code: null });

    const reopened = (
      await api.patch<Incident>(`/api/incidents/${parent.number}`, { state: 'in_progress' })
    ).body;
    expect(reopened.service_restored_at).toBeNull();
    expect(reopened).toMatchObject({
      root_cause: 'Stuck consumer.',
      cause_code: 'Software defect',
    });
  });
});

describe('problem stand-up dates', () => {
  it('is the next 8:00 AM Eastern strictly after now', () => {
    // Eastern Standard Time (UTC-5): 8:00 AM is 13:00Z.
    expect(nextStandupDate(new Date('2026-11-12T12:59:59Z'))).toBe('2026-11-12');
    expect(nextStandupDate(new Date('2026-11-12T13:00:00Z'))).toBe('2026-11-13');
    expect(nextStandupDate(new Date('2026-11-13T03:30:00Z'))).toBe('2026-11-13');
    // Daylight time (UTC-4): 8:00 AM is 12:00Z.
    expect(nextStandupDate(new Date('2026-07-01T11:59:59Z'))).toBe('2026-07-01');
    expect(nextStandupDate(new Date('2026-07-01T12:00:00Z'))).toBe('2026-07-02');
    // Month and year roll over.
    expect(nextStandupDate(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
    expect(standupToday(new Date('2026-11-13T03:30:00Z'))).toBe('2026-11-12');
  });

  it('knows when the call starts, across daylight saving changes', () => {
    expect(standupStartsAt('2026-11-13')).toBe('2026-11-13T13:00:00.000Z');
    expect(standupStartsAt('2026-07-01')).toBe('2026-07-01T12:00:00.000Z');
    expect(standupStartsAt('2026-03-08')).toBe('2026-03-08T12:00:00.000Z');
    expect(standupStartsAt('2026-11-01')).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('problems', () => {
  it('seeds a reviewed problem for each past P1/P2 major incident', async () => {
    const { api } = setup();
    const majors = PAST_MAJOR_INCIDENTS.filter((i) => i.priority !== 'P3');
    const list = (await api.get<Page<ProblemSummary>>('/api/problems')).body;
    expect(list.total).toBe(majors.length);
    expect(list.items.every((p) => ['resolved', 'closed'].includes(p.state))).toBe(true);
    expect(list.items.map((p) => p.number).sort()).toEqual(['PRB0040001', 'PRB0040002']);
    for (const major of majors) {
      const found = (await api.get<Page<ProblemSummary>>(`/api/problems?incident=${major.number}`))
        .body.items;
      expect(found).toHaveLength(1);
      expect(found[0]!.app!.tla).toBe(major.tla);
      const inc = (await api.get<Incident>(`/api/incidents/${major.number}`)).body;
      expect(inc.problem).toBe(found[0]!.number);
    }
    expect((await api.get<Page<ProblemSummary>>('/api/problems?active=true')).body.total).toBe(0);
    // Deterministic: a second build seeds the same problems.
    const again = (await setup().api.get<Page<ProblemSummary>>('/api/problems')).body;
    expect(again.items.map((p) => [p.number, p.short_description, p.state])).toEqual(
      list.items.map((p) => [p.number, p.short_description, p.state]),
    );
  });

  it('creates a problem with defaults and links its incidents', async () => {
    const { api } = setup();
    const p1 = (
      await api.post<Incident>('/api/incidents', {
        short_description: 'CIF lookups failing',
        app_tla: 'CIF',
        impact: 1,
        urgency: 1,
      })
    ).body;
    const p3 = (
      await api.post<Incident>('/api/incidents', {
        short_description: 'OLB profile page errors',
        app_tla: 'OLB',
        impact: 2,
        urgency: 2,
      })
    ).body;

    const created = await api.post<Problem>('/api/problems', {
      short_description: 'CIF naming strategy change broke profile lookups',
      incidents: [p3.number, p1.number, p3.number.toLowerCase()],
    });
    expect(created.status).toBe(201);
    const prb = created.body;
    expect(prb.number).toBe('PRB0040003');
    expect(prb.web_url).toBe('http://localhost:3002/problems/PRB0040003');
    expect(prb).toMatchObject({
      state: 'open',
      priority: 1,
      incident_priority: 1,
      cause_code: 'Under investigation',
      chronic: false,
      proactive: false,
      incidents: [p3.number, p1.number],
      standup_date: nextStandupDate(),
      assigned_to: null,
      root_cause: null,
    });
    // The first incident's application, and that application's support group.
    expect(prb.app!.tla).toBe('OLB');
    expect(prb.assignment_group!.id).toBe(getWorld().appsByTla.get('OLB')!.supportGroupId);
    expect(prb.problem_coordinator!.username).toBe(mim().primary);
    expect(prb.opened_by.username).toBe('svc_incident_auto');
    // Oldest first.
    expect(prb.related_incidents.map((i) => i.number)).toEqual([p1.number, p3.number]);
    expect(prb.journal[0]!.text).toContain(
      `Problem opened to investigate ${p3.number}, ${p1.number}`,
    );
    expect(prb.journal[0]!.text).toContain(`problem stand-up on ${prb.standup_date}`);

    for (const n of [p1.number, p3.number]) {
      const inc = (await api.get<Incident>(`/api/incidents/${n}`)).body;
      expect(inc.problem).toBe(prb.number);
      const entry = lastSystem(inc);
      expect(entry.text).toBe(`Problem ${prb.number} opened to investigate this incident`);
      expect(entry.changes).toEqual([
        { field: 'problem', label: 'Problem', from: null, to: prb.number },
      ]);
    }

    // An incident has one problem.
    const second = await api.post<{ error: string }>('/api/problems', {
      short_description: 'Again',
      incidents: [p1.number],
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain(
      `${p1.number} is already investigated by problem ${prb.number}`,
    );
    const byIncident = (
      await api.get<Page<ProblemSummary>>(`/api/problems?incident=${p1.number.toLowerCase()}`)
    ).body;
    expect(byIncident.items.map((p) => p.number)).toEqual([prb.number]);
    expect((await api.get<Problem>(`/api/problems/${prb.sys_id}`)).body.number).toBe(prb.number);
    expect((await api.get('/api/problems/PRB0049999')).status).toBe(404);
    expect(
      (await api.post('/api/problems', { short_description: 'x', incidents: ['INC0999999'] }))
        .status,
    ).toBe(404);
  });

  it('honours explicit values and stays off the stand-up when asked', async () => {
    const { api } = setup();
    const created = (
      await api.post<Problem>('/api/problems', {
        short_description: 'Kafka consumers stall after broker failover',
        app_tla: 'wir',
        priority: 'P2',
        cause_code: 'software defect',
        proactive: true,
        standup: false,
        assignment_group: 'grp_middleware',
        problem_coordinator: 'tokafor',
        opened_by: 'dwhitfield',
      })
    ).body;
    expect(created).toMatchObject({
      priority: 2,
      incident_priority: null,
      cause_code: 'Software defect',
      proactive: true,
      standup_date: null,
      incidents: [],
    });
    expect(created.app!.tla).toBe('WIR');
    expect(created.assignment_group!.id).toBe('grp_middleware');
    expect(created.problem_coordinator!.username).toBe('tokafor');
    // No incidents and no priority: P3.
    const bare = (await api.post<Problem>('/api/problems', { short_description: 'Bare' })).body;
    expect(bare).toMatchObject({ priority: 3, app: null, assignment_group: null });
  });

  it('lists the stand-up agenda and updates a problem', async () => {
    const { api } = setup();
    const inc = (
      await api.post<Incident>('/api/incidents', {
        short_description: 'PAY failing',
        app_tla: 'PAY',
        impact: 1,
        urgency: 2,
      })
    ).body;
    const later = (await api.post<Incident>('/api/incidents', { short_description: 'Late call' }))
      .body;
    const prb = (
      await api.post<Problem>('/api/problems', {
        short_description: 'PAY failures',
        incidents: [inc.number],
      })
    ).body;
    await api.post<Problem>('/api/problems', { short_description: 'Not today', standup: false });

    const agenda = (await api.get<ProblemStandup>('/api/problems/standup')).body;
    expect(agenda.date).toBe(nextStandupDate());
    expect(agenda.starts_at).toBe(standupStartsAt(agenda.date));
    expect(Date.parse(agenda.starts_at)).toBeGreaterThan(Date.now());
    expect(agenda.problems.map((p) => p.number)).toEqual([prb.number]);
    expect(agenda.problems[0]!.journal.length).toBeGreaterThan(0);
    const byDate = (await api.get<ProblemStandup>(`/api/problems/standup?date=${agenda.date}`))
      .body;
    expect(byDate.problems).toHaveLength(1);
    expect((await api.get('/api/problems/standup?date=tomorrow')).status).toBe(400);
    const next = (await api.get<Page<ProblemSummary>>('/api/problems?standup=next&active=true'))
      .body;
    expect(next.items.map((p) => p.number)).toEqual([prb.number]);
    expect(
      (await api.get<Page<ProblemSummary>>('/api/problems?state=open&app_tla=PAY&q=failures')).body
        .total,
    ).toBe(1);

    const updated = await api.patch<Problem>(`/api/problems/${prb.number}`, {
      state: 'Root Cause Analysis',
      root_cause: 'Connection pool exhausted after a timeout change.',
      cause_code: 'Change',
      chronic: true,
      assigned_to: 'dwhitfield',
      add_incidents: [later.number, inc.number],
      standup: false,
      work_note: 'Timeline attached.',
      updated_by: 'tokafor',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      state: 'root_cause_analysis',
      cause_code: 'Change',
      chronic: true,
      standup_date: null,
      incidents: [inc.number, later.number],
      root_cause: 'Connection pool exhausted after a timeout change.',
    });
    expect(updated.body.updated_by.username).toBe('tokafor');
    const entry = lastSystem(updated.body);
    expect(entry.text).toContain('State changed from Open to Root Cause Analysis');
    expect(entry.text).toContain('Root cause set: Connection pool exhausted');
    expect(entry.text).toContain(`Incidents added: ${later.number}`);
    expect(entry.text).toContain('Taken off the 8:00 AM ET problem stand-up agenda');
    expect(updated.body.journal.at(-1)).toMatchObject({
      type: 'work_note',
      text: 'Timeline attached.',
    });
    expect((await api.get<Incident>(`/api/incidents/${later.number}`)).body.problem).toBe(
      prb.number,
    );
    expect((await api.get<ProblemStandup>('/api/problems/standup')).body.problems).toHaveLength(0);

    const back = (await api.patch<Problem>(`/api/problems/${prb.number}`, { standup: true })).body;
    expect(back.standup_date).toBe(nextStandupDate());
    // A bad reference changes nothing.
    const bad = await api.patch(`/api/problems/${prb.number}`, {
      state: 'resolved',
      change_request: 'CHG0039999',
    });
    expect(bad.status).toBe(400);
    expect((await api.get<Problem>(`/api/problems/${prb.number}`)).body.state).toBe(
      'root_cause_analysis',
    );
  });

  it('reset restores the seeded problems', async () => {
    const { api } = setup();
    await api.post('/api/problems', { short_description: 'Temporary' });
    await api.post('/admin/reset');
    const list = (await api.get<Page<ProblemSummary>>('/api/problems')).body;
    expect(list.items.map((p) => p.number).sort()).toEqual(['PRB0040001', 'PRB0040002']);
    expect((await api.get<Incident>('/api/incidents/INC0010192')).body.problem).toBe('PRB0040001');
  });
});

describe('critical incident communications', () => {
  const openP1 = async (api: ReturnType<typeof client>) =>
    (
      await api.post<Incident>('/api/incidents', {
        short_description: 'Customer profile lookups failing',
        app_tla: 'CIF',
        impact: 1,
        urgency: 1,
        affected_cis: ['OLB', 'MBL'],
        outage_start: '2026-11-12T10:00:00Z',
      })
    ).body;
  const comms = (inc: string) => `/api/incidents/${inc}/communications`;

  it('drafts with defaults from the incident and re-drafts in place', async () => {
    const { api } = setup();
    const inc = await openP1(api);
    const drafted = await api.post<Communication>(comms(inc.number), {
      kind: 'new',
      description: 'Customers cannot open their profile in online or mobile banking.',
    });
    expect(drafted.status).toBe(201);
    const cic = drafted.body;
    expect(cic.number).toBe('CIC0050001');
    expect(cic.web_url).toBe('http://localhost:3002/communications/CIC0050001');
    expect(cic).toMatchObject({
      incident: inc.number,
      kind: 'new',
      state: 'draft',
      subject: `<page> NEW - ${inc.number} - Customer profile lookups failing`,
      to: 'GRP_CIM_Tech_P1',
      from: COMMUNICATION_FROM,
      priority: 1,
      title: 'Customer profile lookups failing',
      start: '2026-11-12T10:00:00.000Z',
      resolved: null,
      duration_minutes: null,
      client_impact: null,
      cause: null,
      sent_at: null,
      sent_by: null,
    });
    expect(cic.systems_impacted.map((a) => a.tla)).toEqual(['CIF', 'OLB', 'MBL']);
    expect(cic.incident_manager!.username).toBe(mim().primary);
    expect(cic.communication_specialist!.username).toBe(mim().secondary);
    expect(cic.technology_owners.map((u) => u.username)).toEqual([
      getWorld().appsByTla.get('CIF')!.ownerUsername,
    ]);
    expect(cic.drafted_by.username).toBe('svc_incident_auto');

    let full = (await api.get<Incident>(`/api/incidents/${inc.number}`)).body;
    expect(full.journal.at(-1)).toMatchObject({
      type: 'work_note',
      text: `Critical Incident Communication CIC0050001 drafted (NEW) for GRP_CIM_Tech_P1 — awaiting review and send: ${cic.web_url}`,
    });
    expect(full.communications.map((c) => [c.number, c.state])).toEqual([['CIC0050001', 'draft']]);

    // Same kind again while unsent: the draft is replaced, not duplicated.
    const redrafted = await api.post<Communication>(comms(inc.number), {
      kind: 'NEW',
      title: 'Customer profiles unavailable',
      description: 'Updated wording.',
      systems_impacted: ['cif', 'CIF', 'olb'],
      start: '2026-11-12T09:55:00Z',
      client_impact: 'Customers cannot see their profile.',
      technology_owners: ['dwhitfield'],
      to: 'GRP_CIM_Tech_P2',
      drafted_by: 'tokafor',
    });
    expect(redrafted.status).toBe(200);
    expect(redrafted.body).toMatchObject({
      number: 'CIC0050001',
      state: 'draft',
      subject: `<page> NEW - ${inc.number} - Customer profiles unavailable`,
      description: 'Updated wording.',
      start: '2026-11-12T09:55:00.000Z',
      client_impact: 'Customers cannot see their profile.',
      to: 'GRP_CIM_Tech_P2',
      drafted_at: cic.drafted_at,
    });
    expect(redrafted.body.systems_impacted.map((a) => a.tla)).toEqual(['CIF', 'OLB']);
    expect(redrafted.body.technology_owners.map((u) => u.username)).toEqual(['dwhitfield']);
    expect(redrafted.body.drafted_by.username).toBe('tokafor');
    full = (await api.get<Incident>(`/api/incidents/${inc.number}`)).body;
    expect(full.communications).toHaveLength(1);
    expect(full.journal.at(-1)!.text).toContain('CIC0050001 draft updated (NEW)');

    // A different kind is its own communication.
    const update = await api.post<Communication>(comms(inc.number), {
      kind: 'update',
      description: 'Fix is being promoted.',
    });
    expect(update.status).toBe(201);
    expect(update.body.number).toBe('CIC0050002');
    expect(update.body.subject).toBe(`<page> UPDATE - ${inc.number} - ${inc.short_description}`);

    const list = (await api.get<Page<CommunicationSummary>>('/api/communications')).body;
    expect(list.items.map((c) => c.number)).toEqual(['CIC0050002', 'CIC0050001']);
    expect(
      (
        await api.get<Page<CommunicationSummary>>(
          `/api/communications?incident=${inc.number}&kind=update&state=draft`,
        )
      ).body.items.map((c) => c.number),
    ).toEqual(['CIC0050002']);
    expect((await api.post(comms(inc.number), { kind: 'new' })).status).toBe(400);
    expect((await api.post(comms(inc.number), { kind: 'memo', description: 'x' })).status).toBe(
      400,
    );
    expect((await api.post(comms('INC0999999'), { kind: 'new', description: 'x' })).status).toBe(
      404,
    );
    expect((await api.get('/api/communications/CIC0059999')).status).toBe(404);
  });

  it('a person sends a draft; a sent communication is final', async () => {
    const { api } = setup();
    const inc = await openP1(api);
    const cic = (
      await api.post<Communication>(comms(inc.number), { kind: 'new', description: 'First.' })
    ).body;

    const bot = await api.post<{ error: string }>(`/api/communications/${cic.number}/send`, {
      sent_by: 'svc_incident_auto',
    });
    expect(bot.status).toBe(400);
    expect(bot.body.error).toContain('sent by a person');

    const sent = await api.post<Communication>(`/api/communications/${cic.number}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.state).toBe('sent');
    expect(sent.body.sent_at).not.toBeNull();
    // Defaults to the communication specialist.
    expect(sent.body.sent_by!.username).toBe(mim().secondary);
    const full = (await api.get<Incident>(`/api/incidents/${inc.number}`)).body;
    expect(full.journal.at(-1)!.text).toContain(
      `Critical Incident Communication ${cic.number} sent to GRP_CIM_Tech_P1 by ${sent.body.sent_by!.name}`,
    );
    expect(full.communications[0]).toMatchObject({ number: cic.number, state: 'sent' });
    expect((await api.post(`/api/communications/${cic.number}/send`)).status).toBe(409);

    // Drafting the same kind after it was sent starts a new communication.
    const again = await api.post<Communication>(comms(inc.number), {
      kind: 'new',
      description: 'Second.',
    });
    expect(again.status).toBe(201);
    expect(again.body.number).toBe('CIC0050002');
    const first = (await api.get<Communication>(`/api/communications/${cic.number}`)).body;
    expect(first).toMatchObject({ state: 'sent', description: 'First.' });
    const explicit = await api.post<Communication>(
      `/api/communications/${again.body.number}/send`,
      { sent_by: 'dwhitfield' },
    );
    expect(explicit.body.sent_by!.username).toBe('dwhitfield');
  });

  it('titles a restored communication RESTORED, or NEW/RESTORED when nothing was sent before', async () => {
    const { api } = setup();
    const inc = await openP1(api);
    await api.patch(`/api/incidents/${inc.number}`, {
      service_restored_at: '2026-11-12T10:47:00Z',
    });
    const announce = (
      await api.post<Communication>(comms(inc.number), { kind: 'new', description: 'Down.' })
    ).body;
    const restored = (
      await api.post<Communication>(comms(inc.number), {
        kind: 'restored',
        description: 'Service is back.',
        cause: 'A naming strategy change.',
        resolution_activities: 'Reverted the change through an emergency change request.',
      })
    ).body;
    // Nothing has been sent yet: this would be the first the group hears of it.
    expect(restored.subject).toBe(`<page> NEW/RESTORED - ${inc.number} - ${inc.short_description}`);
    expect(restored).toMatchObject({
      resolved: '2026-11-12T10:47:00.000Z',
      duration_minutes: 47,
      cause: 'A naming strategy change.',
    });
    const note = (await api.get<Incident>(`/api/incidents/${inc.number}`)).body.journal.at(-1)!;
    expect(note.text).toContain(`${restored.number} drafted (NEW/RESTORED) for GRP_CIM_Tech_P1`);

    // Once the NEW one is out, the restored draft is a plain RESTORED.
    await api.post(`/api/communications/${announce.number}/send`);
    const after = (await api.get<Communication>(`/api/communications/${restored.number}`)).body;
    expect(after.subject).toBe(`<page> RESTORED - ${inc.number} - ${inc.short_description}`);
    const sent = (await api.post<Communication>(`/api/communications/${restored.number}/send`))
      .body;
    expect(sent.subject).toBe(after.subject);

    // Restored straight away, nothing sent before: NEW/RESTORED, also once it is sent.
    const quick = await openP1(api);
    const only = (
      await api.post<Communication>(comms(quick.number), {
        kind: 'restored',
        description: 'Brief blip, already recovered.',
        start: '2h',
        resolved: 'now',
      })
    ).body;
    expect(only.subject).toContain('NEW/RESTORED');
    expect(only.duration_minutes).toBe(120);
    const onlySent = (await api.post<Communication>(`/api/communications/${only.number}/send`))
      .body;
    expect(onlySent.subject).toBe(
      `<page> NEW/RESTORED - ${quick.number} - ${quick.short_description}`,
    );
  });

  it('reset clears communications and health reports the counts', async () => {
    const { api } = setup();
    const inc = await openP1(api);
    await api.post(comms(inc.number), { kind: 'new', description: 'x' });
    const health = (await api.get<Record<string, unknown>>('/health')).body;
    expect(JSON.stringify(health)).toContain('"draft_communications":1');
    await api.post('/admin/reset');
    expect((await api.get<Page<CommunicationSummary>>('/api/communications')).body.total).toBe(0);
  });
});
