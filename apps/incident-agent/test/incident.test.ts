import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { declareIncident, incidentApp, linkAlerts, syncIncidentApp } from '../src/flow/incident';
import { flowDeps, logSignal } from './helpers';

function world() {
  const deps = flowDeps();
  const incidents: Record<string, unknown>[] = [];
  const alertUpdates: Record<string, unknown>[] = [];
  deps.mcp
    .on('list_incidents', (a) => ({
      items: incidents
        .filter((i) => String(i.description).includes(String(a.query)))
        .map((i) => ({ number: i.number, web_url: i.web_url, priority: 1 })),
    }))
    .on('create_incident', (a) => {
      const number = `INC00${10_200 + incidents.length}`;
      const inc = { ...a, number, web_url: `http://sn.test/incidents/${number}`, priority: 1 };
      incidents.push(inc);
      return inc;
    })
    .on('update_incident', (a) => ({ number: a.number }))
    .on('add_incident_note', () => ({ ok: true }))
    .on('update_alert', (a) => {
      alertUpdates.push(a);
      return { id: a.id };
    })
    .on('list_alerts', () => ({
      items: [
        {
          id: 7,
          app_tla: 'MBL',
          web_url: 'http://logs.test/alerts/7',
          first_event_time: new Date().toISOString(),
          incident_number: null,
        },
        {
          id: 8,
          app_tla: 'ZZZ',
          web_url: 'http://logs.test/alerts/8',
          first_event_time: new Date().toISOString(),
          incident_number: null,
        },
      ],
    }));
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL'],
    onset_at: new Date(Date.now() - 120_000).toISOString(),
    signals: [
      logSignal('OLB'),
      {
        source: 'alert',
        id: 'alert-5',
        at: new Date().toISOString(),
        alert_id: 5,
        app_tla: 'OLB',
        service: 'online-banking-bff',
        severity: 'critical',
        description: '5xx',
        web_url: 'http://logs.test/alerts/5',
      },
    ],
  }) as Case;
  c.scope = {
    summary: 'Online and mobile banking customer lookups failing',
    affected_apps: [
      {
        tla: 'OLB',
        name: 'Online Banking',
        tier: 1,
        services: ['online-banking-bff'],
        error_count: 500,
        onset: c.onset_at!,
      },
      {
        tla: 'MBL',
        name: 'Mobile Banking',
        tier: 1,
        services: ['mobile-gateway'],
        error_count: 300,
        onset: c.onset_at!,
      },
    ],
    onset: c.onset_at!,
    signatures: [],
    customer_impact: 'Customers cannot load their profile in online and mobile banking.',
    suggested_impact: 1,
    suggested_urgency: 2,
    severity_reason: '2 tier-1 apps',
    log_links: [
      { label: '800 errors', filter: 'severity>=ERROR', logs_url: 'http://logs.test/logs?query=x' },
    ],
    grouping: [],
  };
  return { deps, c, incidents, alertUpdates };
}

describe('declaring the incident', () => {
  it('files against the confident suspect, else the most affected app', () => {
    const { deps, c } = world();
    expect(incidentApp(deps, c).tla).toBe('OLB');
    c.suspects = [
      {
        tla: 'CIF',
        change_request: null,
        merge_request: null,
        promoted_at: null,
        author: null,
        reason: 'x',
        confidence: 0.8,
      },
    ];
    expect(incidentApp(deps, c).tla).toBe('CIF');
    c.suspects[0]!.confidence = 0.3;
    expect(incidentApp(deps, c).tla).toBe('OLB');
  });

  it('creates one incident with scope, links, priority inputs, group and a correlation id', async () => {
    const { deps, c, incidents } = world();
    c.suspects = [
      {
        tla: 'CIF',
        change_request: { number: 'CHG1', web_url: 'http://sn.test/CHG1' },
        merge_request: null,
        promoted_at: null,
        author: 'jdoe',
        reason: 'every failing app depends on CIF',
        confidence: 0.8,
      },
    ];
    expect(await declareIncident(deps, c)).toBe('created');
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc).toMatchObject({
      short_description: 'Online and mobile banking customer lookups failing',
      contact_type: 'monitoring',
      app_tla: 'CIF',
      assignment_group: 'grp_cif_support',
      impact: 1,
      urgency: 2,
    });
    expect(String(inc.description)).toContain('http://logs.test/logs?query=x');
    expect(String(inc.description)).toContain('CHG1');
    expect(String(inc.description)).toContain(c.correlation_id);
    expect(c.incident?.number).toBe('INC0010200');

    // Running again is a no-op.
    expect(await declareIncident(deps, c)).toBe('existing');
    expect(incidents).toHaveLength(1);
  });

  it('adopts the incident after a crash between create and save', async () => {
    const { deps, c, incidents } = world();
    await declareIncident(deps, c);
    c.incident = null; // the save was lost
    expect(await declareIncident(deps, c)).toBe('found');
    expect(incidents).toHaveLength(1);
    expect(c.incident!.number).toBe('INC0010200');
  });

  it('files human-reported cases as the parent of the calls', async () => {
    const { deps, c, incidents } = world();
    c.kind = 'human-reported';
    c.signals.push({
      source: 'human',
      id: 'h1',
      at: new Date().toISOString(),
      incident_number: 'INC0010150',
      short_description: 'drawers out of balance',
      description: '',
      caller: 'mlopez',
      location: 'Cleveland',
      contact_type: 'phone',
      app_tla: null,
      impact: 2,
      urgency: 2,
      web_url: 'http://sn.test/INC0010150',
    });
    await declareIncident(deps, c);
    expect(incidents[0]!.child_incidents).toEqual(['INC0010150']);
    expect(c.children).toEqual(['INC0010150']);
  });
});

describe('alerts', () => {
  it('acknowledges and links every correlated alert once', async () => {
    const { deps, c, alertUpdates } = world();
    await declareIncident(deps, c);
    expect(await linkAlerts(deps, c)).toBe(2); // the signal's alert 5 and MBL's alert 7, not ZZZ's
    expect(alertUpdates.map((a) => a.id).sort()).toEqual([5, 7]);
    expect(alertUpdates[0]).toMatchObject({
      incident_number: 'INC0010200',
      status: 'acknowledged',
      owner: 'svc_incident_auto',
    });
    const links = deps.mcp
      .callsTo('update_incident')
      .flatMap((a) => (a.add_links as { url: string }[]) ?? []);
    expect(links.map((l) => l.url)).toEqual([
      'http://logs.test/alerts/5',
      'http://logs.test/alerts/7',
    ]);
    expect(await linkAlerts(deps, c)).toBe(0);
  });
});

describe('root cause changes', () => {
  it('re-points the incident and its group with a work note', async () => {
    const { deps, c } = world();
    await declareIncident(deps, c);
    c.root_cause = {
      culprit_tla: 'CIF',
      change_request: { number: 'CHG9', web_url: 'http://sn.test/CHG9' },
      merge_request: null,
      commit: null,
      files: [],
      mechanism: 'profile fields renamed',
      evidence: [],
      ruled_out: [],
      unexplained_apps: [],
      confidence: 0.85,
    };
    expect(await syncIncidentApp(deps, c)).toBe(true);
    const update = deps.mcp.callsTo('update_incident').at(-1)!;
    expect(update).toMatchObject({ app_tla: 'CIF', assignment_group: 'grp_cif_support' });
    expect(String(update.work_note)).toContain('CHG9');
    expect(await syncIncidentApp(deps, c)).toBe(false);
  });
});

describe('triaged step', () => {
  it('declares the incident, links alerts and moves to declared', async () => {
    const { triaged } = await import('../src/flow/steps');
    const { stepCtx } = await import('./helpers');
    const { deps, c } = world();
    deps.mcp
      .on('list_change_requests', () => ({ items: [] }))
      .on('list_merge_requests', () => ({ items: [] }));
    c.milestones.quick_rca = new Date().toISOString(); // quick RCA already ran
    c.background.deep_rca = {
      state: 'done',
      started_at: '',
      finished_at: '',
      error: null,
      runs: 1,
    };
    const res = await triaged(deps)(c, stepCtx(deps.store));
    expect(res).toMatchObject({ next: 'declared' });
    expect(c.incident?.number).toBe('INC0010200');
    expect(c.alerts.every((a) => a.linked)).toBe(true);
  });

  it('abandons a split-off case whose app stopped failing', async () => {
    const { triaged } = await import('../src/flow/steps');
    const { stepCtx } = await import('./helpers');
    const { deps, c } = world();
    c.split_from = 'case-x';
    c.milestones.quick_rca = new Date().toISOString();
    c.background.deep_rca = {
      state: 'done',
      started_at: '',
      finished_at: '',
      error: null,
      runs: 1,
    };
    for (const a of c.scope!.affected_apps) a.error_count = 0;
    expect(await triaged(deps)(c, stepCtx(deps.store))).toMatchObject({ next: 'abandoned' });
    expect(c.incident).toBeNull();
  });
});
