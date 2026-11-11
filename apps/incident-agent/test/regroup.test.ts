import { describe, expect, it } from 'vitest';
import type { Case, RootCause } from '../src/cases/types';
import { autoRegroup, humanRegroup, mergeCases, pickPrimary, splitApp } from '../src/flow/regroup';
import { flowDeps, logSignal, stepCtx } from './helpers';

const rc = (
  tla: string,
  chg: string,
  unexplained: { tla: string; reason: string }[] = [],
): RootCause => ({
  culprit_tla: tla,
  change_request: { number: chg, web_url: `http://sn.test/${chg}` },
  merge_request: {
    project: `keybank/${tla}00/api`,
    iid: 9,
    title: 'x',
    web_url: 'http://gl.test/mr/9',
  },
  commit: null,
  files: [],
  mechanism: 'm',
  evidence: [],
  ruled_out: [],
  unexplained_apps: unexplained,
  confidence: 0.9,
});

function world() {
  const deps = flowDeps();
  deps.mcp
    .on('update_incident', () => ({}))
    .on('link_child_incidents', () => ({}))
    .on('update_alert', () => ({}))
    .on('post_message', () => ({ id: 'm' }))
    .on('add_channel_members', (a) => ({ added: a.members }))
    .on('remove_channel_member', () => ({}))
    .on('add_incident_note', () => ({}));
  const mk = (n: number, apps: string[], prio: number, opened: string) => {
    const c = deps.store.create({
      kind: 'monitoring',
      apps,
      signals: apps.map((a) => logSignal(a)),
    }) as Case;
    c.opened_at = opened;
    c.phase = 'investigating';
    c.incident = {
      number: `INC00102${n}`,
      web_url: `http://sn.test/INC00102${n}`,
      app_tla: apps[0]!,
      assignment_group: null,
      priority: prio,
    };
    c.channel = { id: `ch_${n}`, name: `inc00102${n}-x`, web_url: `http://teams.test/ch_${n}` };
    c.members = [
      { username: 'mbell', reason: 'incident commander (NOC on-call)', role: 'owner' },
      {
        username: `rep${n}`,
        reason: `on-call for ${apps[0]} (failing since 19:14 UTC)`,
        role: 'member',
      },
    ];
    c.relations = apps.map((tla) => ({ tla, score: 1, reasons: ['x'], tentative: false }));
    deps.store.save(c);
    return c;
  };
  return { deps, ctx: stepCtx(deps.store), mk };
}

describe('merging cases', () => {
  it('picks the higher priority (older on a tie) as primary', () => {
    const { mk } = world();
    const a = mk(10, ['OLB'], 2, '2026-11-11T19:10:00Z');
    const b = mk(11, ['MBL'], 1, '2026-11-11T19:13:00Z');
    expect(pickPrimary(a, b)[0].id).toBe(b.id);
    b.incident!.priority = 2;
    expect(pickPrimary(a, b)[0].id).toBe(a.id);
  });

  it('makes the secondary a child (moving its children first), re-points alerts and joins the channels', async () => {
    const { deps, ctx, mk } = world();
    const primary = mk(10, ['OLB', 'MBL'], 1, '2026-11-11T19:10:00Z');
    const secondary = mk(11, ['TLR'], 2, '2026-11-11T19:13:00Z');
    secondary.children = ['INC0010250', 'INC0010251'];
    secondary.alerts = [
      {
        id: 7,
        web_url: 'http://logs.test/alerts/7',
        app_tla: 'TLR',
        linked: true,
        resolved: false,
      },
    ];
    const r = await mergeCases(deps, ctx, secondary, primary, 'same root cause (CIF CHG1)');
    expect(r.merged).toBe(true);
    const updates = deps.mcp.callsTo('update_incident');
    expect(updates.map((u) => [u.number, u.parent_incident])).toEqual([
      ['INC0010250', 'INC0010210'],
      ['INC0010251', 'INC0010210'],
    ]);
    expect(deps.mcp.callsTo('link_child_incidents')[0]).toMatchObject({
      parent: 'INC0010210',
      children: ['INC0010211'],
    });
    expect(deps.mcp.callsTo('update_alert')[0]).toMatchObject({
      id: 7,
      incident_number: 'INC0010210',
    });
    const posts = deps.mcp.callsTo('post_message');
    expect(posts[0]).toMatchObject({ channel: 'ch_11' });
    expect(String(posts[0]!.body)).toContain('Merged into #inc0010210-x');
    expect(deps.mcp.callsTo('add_channel_members')[0]!.members).toEqual([
      { user: 'rep11', reason: 'joined from #inc0010211-x: same cause' },
    ]);
    expect(primary.apps).toEqual(['OLB', 'MBL', 'TLR']);
    expect(primary.children).toEqual(
      expect.arrayContaining(['INC0010250', 'INC0010251', 'INC0010211']),
    );
    expect(secondary.phase).toBe('abandoned');
    expect(secondary.merged_into).toBe(primary.id);
  });

  it('never merges into a resolved case, and respects hysteresis unless a human asked', async () => {
    const { deps, ctx, mk } = world();
    const a = mk(10, ['OLB'], 1, '2026-11-11T19:10:00Z');
    const b = mk(11, ['TLR'], 2, '2026-11-11T19:13:00Z');
    b.phase = 'resolved';
    expect((await mergeCases(deps, ctx, a, b, 'x')).merged).toBe(false);
    b.phase = 'investigating';
    a.last_regroup_at = new Date().toISOString();
    expect((await mergeCases(deps, ctx, a, b, 'x')).why).toBe('regrouped too recently');
    expect((await mergeCases(deps, ctx, a, b, 'x', { human: true })).merged).toBe(true);
  });
});

describe('splitting an app out', () => {
  it('moves the app to its own case, notes it in both places and removes a rep who was only there for it', async () => {
    const { deps, ctx, mk } = world();
    const c = mk(10, ['OLB', 'MBL', 'TLR'], 1, '2026-11-11T19:10:00Z');
    c.members.push({
      username: 'tlrrep',
      reason: 'on-call for TLR (failing since 19:15 UTC)',
      role: 'member',
    });
    const reply = await humanRegroup(deps, ctx)(c, { kind: 'split', tla: 'TLR', by: 'kstreich' });
    expect(reply).toContain('split TLR out');
    expect(c.apps).toEqual(['OLB', 'MBL']);
    expect(ctx.tracked[0]!.apps).toEqual(['TLR']);
    expect(String(deps.mcp.callsTo('update_incident')[0]!.work_note)).toContain('TLR split out');
    expect(String(deps.mcp.callsTo('post_message')[0]!.body)).toContain('Split TLR');
    expect(deps.mcp.callsTo('remove_channel_member')).toEqual([
      { channel: 'ch_10', user: 'tlrrep' },
    ]);
  });

  it('never splits off the app the fix changes', async () => {
    const { deps, ctx, mk } = world();
    const c = mk(10, ['OLB', 'CIF'], 1, '2026-11-11T19:10:00Z');
    c.fix_mr = {
      project: 'keybank/CIF00/customer-profile-api',
      iid: 10,
      web_url: 'u',
      state: 'opened',
      source_branch: 'b',
      merged_at: null,
      merge_commit_sha: null,
    };
    const r = await splitApp(deps, ctx, c, 'CIF', 'x', { human: true });
    expect(r.split).toBe(false);
    expect(r.why).toContain('what the fix changes');
  });
});

describe('automatic regroups from the deep RCA', () => {
  it('two cases with the same culprit become one incident', async () => {
    const { deps, ctx, mk } = world();
    const a = mk(10, ['OLB'], 1, '2026-11-11T19:10:00Z');
    const b = mk(11, ['MBL'], 1, '2026-11-11T19:13:00Z');
    a.root_cause = rc('CIF', 'CHG1');
    b.root_cause = rc('CIF', 'CHG1');
    await autoRegroup(deps, ctx, b);
    expect(b.phase).toBe('abandoned');
    expect(a.apps).toEqual(['OLB', 'MBL']);
    // Only once.
    await autoRegroup(deps, ctx, a);
    expect(deps.mcp.callsTo('link_child_incidents')).toHaveLength(1);
  });

  it('an app the root cause does not explain is split off', async () => {
    const { deps, ctx, mk } = world();
    const c = mk(10, ['OLB', 'MBL', 'ZZZ'], 1, '2026-11-11T19:10:00Z');
    c.root_cause = rc('CIF', 'CHG1', [{ tla: 'ZZZ', reason: 'ZZZ does not depend on CIF' }]);
    await autoRegroup(deps, ctx, c);
    expect(c.apps).toEqual(['OLB', 'MBL']);
    expect(ctx.tracked.map((t) => t.apps)).toEqual([['ZZZ']]);
  });
});
