import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import {
  draftResolution,
  resolveAlerts,
  verifyRecovery,
  writeResolution,
} from '../src/flow/verify';
import { flowDeps } from './helpers';

const t0 = Date.parse('2026-11-11T19:14:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Errors per window: before the fix, after the fix, and the background before the incident. */
function world(env: Record<string, string> = {}) {
  const deps = flowDeps({
    env: { AGENT_VERIFY_HEALTHY_SEC: '60', AGENT_VERIFY_TIMEOUT_SEC: '600', ...env },
  });
  const deployed = t0 + 10 * 60_000;
  let afterErrors = 500;
  deps.mcp
    .on('summarize_errors', (a) => {
      const start = Date.parse(String(a.start_time));
      const end = a.end_time ? Date.parse(String(a.end_time)) : Number.NaN;
      if (end && end <= t0) return { total_matched: 14, items: [] }; // 1/min background over 14 min
      if (start < deployed && end && end <= deployed) return { total_matched: 3000, items: [] }; // 300/min
      return { total_matched: afterErrors, items: [] };
    })
    .on('update_incident', () => ({}))
    .on('update_alert', () => ({}));
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL'],
    onset_at: iso(t0),
  }) as Case;
  c.opened_at = iso(t0 + 20_000);
  c.incident = {
    number: 'INC0010234',
    web_url: 'http://sn.test/INC0010234',
    app_tla: 'CIF',
    assignment_group: null,
    priority: 1,
  };
  c.scope = {
    summary: 's',
    affected_apps: [
      {
        tla: 'OLB',
        name: 'Online Banking',
        tier: 1,
        services: [],
        error_count: 2000,
        onset: iso(t0),
      },
      {
        tla: 'MBL',
        name: 'Mobile Banking',
        tier: 1,
        services: [],
        error_count: 1000,
        onset: iso(t0),
      },
    ],
    onset: iso(t0),
    signatures: [],
    customer_impact: 'Customers cannot load profiles.',
    suggested_impact: 1,
    suggested_urgency: 1,
    severity_reason: 'x',
    log_links: [],
    grouping: [],
  };
  c.root_cause = {
    culprit_tla: 'CIF',
    change_request: { number: 'CHG0030081', web_url: 'http://sn.test/CHG0030081' },
    merge_request: {
      project: 'keybank/CIF00/customer-profile-api',
      iid: 9,
      title: 'x',
      web_url: 'http://gl.test/mr/9',
    },
    commit: null,
    files: [],
    mechanism: 'snake_case broke callers.',
    evidence: [],
    ruled_out: [],
    unexplained_apps: [],
    confidence: 0.9,
  };
  c.fix_mr = {
    project: 'keybank/CIF00/customer-profile-api',
    iid: 10,
    web_url: 'http://gl.test/mr/10',
    state: 'merged',
    source_branch: 'fix/x',
    merged_at: iso(deployed - 60_000),
    merge_commit_sha: 'f',
  };
  c.fix = {
    project: 'keybank/CIF00/customer-profile-api',
    strategy: 'revert',
    justification: 'x',
    changes: [{ path: 'a', find: 'b' }],
    title: 'Revert',
    description: 'd',
  };
  c.change = {
    number: 'CHG0030090',
    web_url: 'http://sn.test/CHG0030090',
    state: 'closed',
    deployed_at: iso(deployed),
  };
  c.milestones = {
    declared: iso(t0 + 60_000),
    assembled: iso(t0 + 70_000),
    fix_proposed: iso(t0 + 5 * 60_000),
  };
  c.alerts = [
    { id: 1, web_url: 'http://logs.test/alerts/1', app_tla: 'OLB', linked: true, resolved: false },
  ];
  c.children = ['INC0010240'];
  return { deps, c, deployed, setAfter: (n: number) => (afterErrors = n) };
}

describe('verifying recovery', () => {
  it('is recovering while errors stay high, healthy after the rate holds low long enough', async () => {
    const { deps, c, deployed, setAfter } = world();
    let r = await verifyRecovery(deps, c, deployed + 30_000);
    expect(r.status).toBe('recovering');
    expect(r.beforePerMin).toBeCloseTo(300, 0);
    setAfter(0);
    r = await verifyRecovery(deps, c, deployed + 60_000);
    expect(r.status).toBe('recovering'); // healthy for 0s so far
    expect(c.verification?.healthy_since).toBe(iso(deployed + 60_000));
    r = await verifyRecovery(deps, c, deployed + 125_000);
    expect(r.status).toBe('healthy');
    expect(r.afterPerMin).toBe(0);
  });

  it('a relapse resets the healthy window; no recovery by the timeout sends it back', async () => {
    const { deps, c, deployed, setAfter } = world();
    setAfter(0);
    await verifyRecovery(deps, c, deployed + 60_000);
    setAfter(500);
    await verifyRecovery(deps, c, deployed + 90_000);
    expect(c.verification?.healthy_since).toBeNull();
    expect((await verifyRecovery(deps, c, deployed + 700_000)).status).toBe('timeout');
  });
});

describe('the resolution', () => {
  it('drafts close notes with root cause, fix, timeline and times to detect and restore', async () => {
    const { deps, c, deployed, setAfter } = world();
    setAfter(0);
    await verifyRecovery(deps, c, deployed + 60_000);
    const d = draftResolution(c);
    expect(d.close_code).toBe('Resolved by change');
    expect(d.close_notes).toContain('CHG0030081');
    expect(d.close_notes).toContain('keybank/CIF00/customer-profile-api!10');
    expect(d.close_notes).toContain('CHG0030090');
    expect(d.close_notes).toContain('19:14 UTC Errors started');
    expect(d.close_notes).toContain('Time to detect: 20s');
    expect(d.close_notes).toContain('Time to restore: 11m 0s');
    expect(d.close_notes).toContain('INC0010240');
  });

  it('demo mode leaves the incident in progress with the draft as a work note', async () => {
    const { deps, c } = world();
    expect(await writeResolution(deps, c)).toEqual({ resolved: false });
    const update = deps.mcp.callsTo('update_incident')[0]!;
    expect(update.state).toBe('in_progress');
    expect(String(update.work_note)).toContain('Resolution drafted');
    expect(c.resolution?.resolved_at).toBeNull();
  });

  it('auto mode resolves (children follow) and alerts are resolved', async () => {
    const { deps, c } = world({ AGENT_AUTO_RESOLVE: 'true' });
    expect(await writeResolution(deps, c)).toEqual({ resolved: true });
    expect(deps.mcp.callsTo('update_incident')[0]).toMatchObject({
      state: 'resolved',
      close_code: 'Resolved by change',
    });
    expect(await resolveAlerts(deps, c)).toBe(1);
    expect(deps.mcp.callsTo('update_alert')[0]).toMatchObject({ id: 1, status: 'resolved' });
    expect(await resolveAlerts(deps, c)).toBe(0);
  });
});

describe('verifying and resolution steps', () => {
  async function steps() {
    return import('../src/flow/steps');
  }
  function withChannel(env: Record<string, string> = {}) {
    const w = world({ AGENT_VERIFY_HEALTHY_SEC: '10', ...env });
    w.deps.mcp
      .on('post_message', () => ({ id: 'm' }))
      .on('add_incident_note', () => ({}))
      .on('search_logs', (a) => ({
        total: 0,
        items: [],
        logs_url: `http://logs.test/?q=${encodeURIComponent(String(a.filter))}`,
      }))
      .on('get_incident', () => ({ state: 'in_progress' }));
    w.c.channel = { id: 'ch_1', name: 'inc0010234-x', web_url: 'http://teams.test/ch_1' };
    w.c.phase = 'verifying';
    w.c.change!.deployed_at = new Date(Date.now() - 5 * 60_000).toISOString();
    return w;
  }

  it('recovered: posts before/after, drafts the resolution and waits for a human', async () => {
    const { verifying, resolutionDrafted } = await steps();
    const { stepCtx } = await import('./helpers');
    const { deps, c, setAfter } = withChannel();
    setAfter(0);
    const ctx = stepCtx(deps.store);
    expect(await verifying(deps)(c, ctx)).toMatchObject({ wait: expect.any(Number) }); // healthy_since starts now
    c.verification!.healthy_since = new Date(Date.now() - 15_000).toISOString();
    expect(await verifying(deps)(c, ctx)).toMatchObject({ next: 'resolution_drafted' });
    const bodies = deps.mcp.callsTo('post_message').map((p) => String(p.body));
    expect(bodies.some((b) => b.startsWith('**Recovered.**'))).toBe(true);
    expect(bodies.some((b) => b.startsWith('**Resolution drafted**'))).toBe(true);
    // A human resolves it.
    c.phase = 'resolution_drafted';
    expect(await resolutionDrafted(deps)(c, ctx)).toMatchObject({ wait: expect.any(Number) });
    deps.mcp.on('get_incident', () => ({
      state: 'resolved',
      resolved_by: { username: 'dwhitfield' },
    }));
    expect(await resolutionDrafted(deps)(c, ctx)).toMatchObject({ next: 'resolved' });
    expect(deps.mcp.callsTo('update_alert').length).toBe(1);
  });

  it('auto-resolve goes straight to resolved', async () => {
    const { verifying } = await steps();
    const { stepCtx } = await import('./helpers');
    const { deps, c, setAfter } = withChannel({ AGENT_AUTO_RESOLVE: 'true' });
    setAfter(0);
    c.verification = {
      before_per_min: 300,
      after_per_min: 0,
      healthy_since: new Date(Date.now() - 15_000).toISOString(),
      started_at: c.change!.deployed_at!,
      logs_url: null,
    };
    expect(await verifying(deps)(c, stepCtx(deps.store))).toMatchObject({ next: 'resolved' });
    expect(deps.mcp.callsTo('update_incident').some((u) => u.state === 'resolved')).toBe(true);
  });

  it('no recovery by the timeout goes back to investigating with a fresh fix attempt', async () => {
    const { verifying } = await steps();
    const { stepCtx } = await import('./helpers');
    const { deps, c } = withChannel({ AGENT_VERIFY_TIMEOUT_SEC: '60' });
    deps.mcp
      .on('list_change_requests', () => ({ items: [] }))
      .on('list_merge_requests', () => ({ items: [] }));
    expect(await verifying(deps)(c, stepCtx(deps.store))).toMatchObject({ next: 'investigating' });
    expect(c.fix_mr).toBeNull();
    expect(c.change).toBeNull();
    expect(c.milestones.fix_attempt).toBe('2');
    expect(String(deps.mcp.callsTo('post_message').at(-1)!.body)).toContain('Not recovered yet');
  });
});
