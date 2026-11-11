import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { flush, postNow, queue, windowMs } from '../src/flow/announce';
import { assembled } from '../src/flow/steps';
import * as T from '../src/messages/teams';
import { flowDeps, realGraph, stepCtx } from './helpers';

const onset = '2026-11-11T19:14:00.000Z';

/** A fully populated, deterministic case for snapshots. */
function sample(): Case {
  const deps = flowDeps();
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL', 'TLR'],
    onset_at: onset,
  }) as Case;
  c.id = 'case-sample';
  c.incident = {
    number: 'INC0010234',
    web_url: 'http://sn.test/incidents/INC0010234',
    app_tla: 'CIF',
    assignment_group: 'grp_cif_support',
    priority: 1,
  };
  c.channel = {
    id: 'ch_1',
    name: 'inc0010234-customer-lookups-failing',
    web_url: 'http://teams.test/channels/ch_1',
  };
  c.members = [
    { username: 'mbell', reason: 'incident commander (NOC on-call)', role: 'owner' },
    { username: 'aklocko2', reason: 'on-call for OLB (failing since 19:14 UTC)', role: 'member' },
    { username: 'mratke', reason: 'on-call for MBL (failing since 19:14 UTC)', role: 'member' },
    {
      username: 'kstreich',
      reason: 'on-call for CIF: no errors there, but OLB, MBL and TLR depend on it',
      role: 'member',
    },
    {
      username: 'jdoe',
      reason: 'author of keybank/CIF00/customer-profile-api!9 (suspected change)',
      role: 'member',
    },
  ];
  c.upstream_candidates = [
    { tla: 'CIF', name: 'Customer Information File', covers: 3, of: 3, hops: 1, failing: false },
  ];
  c.relations = [
    { tla: 'OLB', score: 1, reasons: ['first signal'], tentative: false },
    { tla: 'MBL', score: 0.8, reasons: ['errors on both sides name CIF'], tentative: false },
    {
      tla: 'TLR',
      score: 0.9,
      reasons: ['errors on both sides name CIF', 'TLR calls DEP'],
      tentative: false,
    },
  ];
  c.scope = {
    summary: 'Online banking, mobile and teller customer lookups failing',
    affected_apps: [
      {
        tla: 'OLB',
        name: 'Online Banking',
        tier: 1,
        services: ['online-banking-bff'],
        error_count: 842,
        onset,
      },
      {
        tla: 'MBL',
        name: 'Mobile Banking',
        tier: 1,
        services: ['mobile-gateway'],
        error_count: 555,
        onset: '2026-11-11T19:14:02.000Z',
      },
      {
        tla: 'TLR',
        name: 'Teller Workstation',
        tier: 1,
        services: ['teller-workstation-api'],
        error_count: 133,
        onset: '2026-11-11T19:14:11.000Z',
      },
    ],
    onset,
    signatures: [
      {
        app_tla: 'MBL',
        error_type: 'UpstreamContractError',
        message: 'customer-profile-api: customerId missing',
        sample_insert_id: 'i1',
        stack_excerpt: '',
      },
    ],
    customer_impact: 'Customers and tellers cannot load customer profiles.',
    suggested_impact: 1,
    suggested_urgency: 1,
    severity_reason: '3 tier-1 apps failing',
    log_links: [
      {
        label: '1,530 errors in 3 affected apps since 19:12 UTC',
        filter: 'f1',
        logs_url: 'http://logs.test/logs?query=f1',
      },
      {
        label: 'Top signature (555): UpstreamContractError',
        filter: 'f2',
        logs_url: 'http://logs.test/logs?query=f2',
      },
    ],
    grouping: [],
  };
  c.suspects = [
    {
      tla: 'CIF',
      change_request: {
        number: 'CHG0030081',
        web_url: 'http://sn.test/change_requests/CHG0030081',
      },
      merge_request: {
        project: 'keybank/CIF00/customer-profile-api',
        iid: 9,
        title: 'Adopt naming standard',
        web_url: 'http://gl.test/mr/9',
      },
      promoted_at: '2026-11-11T19:12:30.000Z',
      author: 'jdoe',
      reason:
        'CHG0030081 promoted CIF 1m 30s before the errors started; every failing app depends on CIF',
      confidence: 0.82,
    },
    {
      tla: 'ATH',
      change_request: {
        number: 'CHG0030083',
        web_url: 'http://sn.test/change_requests/CHG0030083',
      },
      merge_request: null,
      promoted_at: null,
      author: null,
      reason: 'x',
      confidence: 0.55,
    },
  ];
  return c;
}

const rootCause = {
  culprit_tla: 'CIF',
  change_request: { number: 'CHG0030081', web_url: 'http://sn.test/change_requests/CHG0030081' },
  merge_request: {
    project: 'keybank/CIF00/customer-profile-api',
    iid: 9,
    title: 'Adopt naming standard',
    web_url: 'http://gl.test/mr/9',
  },
  commit: null,
  files: ['src/main/resources/application.yml'],
  mechanism: 'Profile JSON switched to snake_case, so callers no longer find customerId.',
  evidence: [
    {
      claim: 'CHG0030081 put CIF into production at 19:12 UTC',
      web_url: 'http://sn.test/change_requests/CHG0030081',
    },
  ],
  ruled_out: [
    { ref: 'CHG0030083 ATH: bump jose', reason: 'the diff has nothing to do with the errors' },
  ],
  unexplained_apps: [],
  confidence: 0.9,
};

describe('message templates (snapshots)', () => {
  const graph = realGraph();
  it('briefing', () => {
    const m = T.briefing(sample(), graph, {
      notInvited: [{ user: 'dgreen', reason: 'backup on-call for CIF' }],
    });
    expect(m.importance).toBe('urgent');
    expect(m.mentions).toEqual(['aklocko2', 'mratke', 'kstreich', 'jdoe']);
    expect(m.body).toMatchSnapshot();
    // Every link in the briefing comes from the case's tool results.
    for (const url of m.body.match(/\]\((http[^)]+)\)/g) ?? []) expect(url).toMatch(/\.test\//);
  });
  it('root cause confirmed and changed', () => {
    const c = sample();
    expect(T.rootCauseUpdate(c, rootCause, null).body).toMatchSnapshot();
    expect(
      T.rootCauseUpdate(c, rootCause, { tla: 'ATH', number: 'CHG0030083' }).body,
    ).toMatchSnapshot();
  });
  it('apps joined', () => {
    const c = sample();
    c.relations.push({
      tla: 'PAY',
      score: 0.6,
      reasons: ['errors on both sides name CIF'],
      tentative: false,
    });
    expect(T.appsJoined(c, graph, ['PAY']).body).toMatchSnapshot();
  });
  it('fix, change, promotion, recovery, resolution, callers, failure', () => {
    const c = sample();
    c.fix_mr = {
      project: 'keybank/CIF00/customer-profile-api',
      iid: 10,
      web_url: 'http://gl.test/mr/10',
      state: 'opened',
      source_branch: 'fix/inc0010234-x',
      merged_at: null,
      merge_commit_sha: null,
    };
    c.fix = {
      project: 'keybank/CIF00/customer-profile-api',
      strategy: 'revert',
      justification: 'the change is self-contained',
      changes: [{ path: 'a', find: 'x', replace: 'y' }],
      title: 'Revert snake_case (INC0010234)',
      description: 'd',
    };
    c.change = {
      number: 'CHG0030090',
      web_url: 'http://sn.test/change_requests/CHG0030090',
      state: 'closed',
      deployed_at: '2026-11-11T19:30:00.000Z',
    };
    c.milestones.verifying = '2026-11-11T19:31:00.000Z';
    expect(T.fixReady(c, ['jdoe', 'kstreich']).body).toMatchSnapshot();
    expect(T.changeRaised(c).body).toMatchSnapshot();
    expect(T.promoted(c).body).toMatchSnapshot();
    expect(T.recovered(c, 120.5, 0.3, 'http://logs.test/after').body).toMatchSnapshot();
    expect(T.notRecovered(c, 40, null).body).toMatchSnapshot();
    expect(T.resolutionDrafted(c, false).body).toMatchSnapshot();
    expect(T.resolutionDrafted(c, true).body).toMatchSnapshot();
    expect(
      T.callersGrouped(c, [
        { number: 'INC0010240', location: 'Akron' },
        { number: 'INC0010241', location: 'Cleveland' },
      ]).body,
    ).toMatchSnapshot();
    expect(T.failure(c, 'triage: tool unavailable').body).toMatchSnapshot();
  });
});

describe('announcing', () => {
  function setup() {
    const deps = flowDeps({ env: { AGENT_SPEED: '1' } });
    deps.mcp
      .on('post_message', (a) => ({
        id: 'msg_1',
        web_url: `http://teams.test/m/${String(a.body).length}`,
      }))
      .on('add_incident_note', () => ({}))
      .on('update_incident', () => ({}));
    const c = sample();
    deps.store.save(c);
    return { deps, c };
  }

  it('posts each update once, coalesces within the window and mirrors work notes', async () => {
    const { deps, c } = setup();
    expect(await postNow(deps, c, 'briefing', T.briefing(c, deps.graph()))).toBe(true);
    expect(await postNow(deps, c, 'briefing', T.briefing(c, deps.graph()))).toBe(false);
    expect(queue(deps, c, 'a', { body: 'first', mentions: ['x'], importance: 'normal' })).toBe(
      true,
    );
    expect(queue(deps, c, 'a', { body: 'dup', mentions: [], importance: 'normal' })).toBe(false);
    queue(deps, c, 'b', { body: 'second', mentions: ['y'], importance: 'high' });
    // Within the window right after the briefing: nothing goes out.
    expect(await flush(deps, c)).toBe(0);
    c.last_post_at = new Date(Date.now() - windowMs(deps) - 1).toISOString();
    expect(await flush(deps, c)).toBe(2);
    const posts = deps.mcp.callsTo('post_message');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      channel: 'ch_1',
      body: 'first\n\n---\n\nsecond',
      mentions: ['x', 'y'],
      importance: 'high',
    });
    expect(deps.mcp.callsTo('add_incident_note').length).toBe(2);
    expect(queue(deps, c, 'a', { body: 'again', mentions: [], importance: 'normal' })).toBe(false);
  });

  it('the assembled step posts the briefing and moves to briefed', async () => {
    const { deps, c } = setup();
    deps.mcp
      .on('search_support_groups', () => ({ items: [] }))
      .on('get_merge_request', () => ({ author: 'jdoe' }))
      .on('get_channel', () => ({ id: 'ch_1', members: [] }))
      .on('add_channel_members', (a) => ({ added: a.members }));
    c.phase = 'assembled';
    expect(await assembled(deps)(c, stepCtx(deps.store))).toMatchObject({ next: 'briefed' });
    const post = deps.mcp.callsTo('post_message')[0]!;
    expect(String(post.body)).toContain(
      '## 🚨 P1: Online banking, mobile and teller customer lookups failing',
    );
    expect(post.importance).toBe('urgent');
    expect(c.milestones['announce:briefing']).toBeDefined();
  });
});
