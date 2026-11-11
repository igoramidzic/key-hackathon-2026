import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { type AppNode, DependencyGraph } from '../src/correlate/graph';
import { changedText, heuristicDeepRca, quickRca, relevance, tokens } from '../src/flow/rca';
import { flowDeps } from './helpers';

/**
 * A synthetic estate: WEB and MOB fail; both call PRF (healthy, the culprit). Every app calls
 * HUB. WEB has an unrelated change of its own, HUB has a dependency bump, and PRF has a second
 * MR that was merged but never promoted.
 */
const node = (tla: string, name: string): AppNode => ({
  tla,
  name,
  tier: 1,
  service: `${name.toLowerCase().replace(/\s+/g, '-')}`,
  repos: [`keybank/${tla}00/${tla.toLowerCase()}-api`],
  support_group: { id: `grp_${tla.toLowerCase()}`, name: `${tla} Support` },
  on_call: { primary: `${tla.toLowerCase()}_oncall`, secondary: `${tla.toLowerCase()}_backup` },
  web_url: `http://sn.test/apps/${tla}`,
});
const graph = DependencyGraph.fromEdges(
  [
    node('WEB', 'Web Banking'),
    node('MOB', 'Mobile Banking'),
    node('PRF', 'Profile Service'),
    node('HUB', 'Auth Hub'),
  ],
  [
    ['WEB', 'PRF'],
    ['MOB', 'PRF'],
    ['WEB', 'HUB'],
    ['MOB', 'HUB'],
    ['PRF', 'HUB'],
  ],
);

const onset = '2026-11-11T19:14:00.000Z';
const at = (minBefore: number) => new Date(Date.parse(onset) - minBefore * 60_000).toISOString();

const changes: Record<
  string,
  { number: string; app: string; at: string; desc: string; mr: string }[]
> = {
  PRF: [
    {
      number: 'CHG1',
      app: 'PRF',
      at: at(3),
      desc: 'profile-api: serialize customer fields in snake_case',
      mr: 'keybank/PRF00/prf-api!7',
    },
  ],
  WEB: [
    {
      number: 'CHG2',
      app: 'WEB',
      at: at(2),
      desc: 'web: update profile error copy',
      mr: 'keybank/WEB00/web-api!3',
    },
  ],
  HUB: [
    {
      number: 'CHG3',
      app: 'HUB',
      at: at(1),
      desc: 'hub: bump jose 5.9.3 → 5.9.6',
      mr: 'keybank/HUB00/hub-api!9',
    },
    {
      number: 'CHG4',
      app: 'HUB',
      at: new Date(Date.parse(onset) + 10 * 60_000).toISOString(),
      desc: 'hub: log level tweak',
      mr: 'keybank/HUB00/hub-api!10',
    },
  ],
  MOB: [],
};

const mrs: Record<string, { title: string; diff: string; author: string }> = {
  'keybank/PRF00/prf-api!7': {
    title: 'Serialize customer profile fields in snake_case',
    author: 'jdoe',
    diff: '@@ -1,3 +1,3 @@\n spring:\n   jackson:\n-    property-naming-strategy: LOWER_CAMEL_CASE\n+    property-naming-strategy: SNAKE_CASE\n # customerId becomes customer_id\n',
  },
  'keybank/WEB00/web-api!3': {
    title: 'Update profile error copy',
    author: 'copywriter',
    diff: '@@ -1 +1 @@\n-  "Something went wrong"\n+  "We could not load your details"\n',
  },
  'keybank/HUB00/hub-api!9': {
    title: 'chore(deps): bump jose from 5.9.3 to 5.9.6',
    author: 'renovate',
    diff: '@@ -1 +1 @@\n-    "jose": "5.9.3"\n+    "jose": "5.9.6"\n',
  },
  'keybank/HUB00/hub-api!10': {
    title: 'Log level tweak',
    author: 'x',
    diff: '@@ -1 +1 @@\n-level: info\n+level: warn\n',
  },
};

function rcaCase() {
  const deps = flowDeps();
  deps.graph = () => graph;
  deps.mcp
    .on('list_change_requests', (a) => ({
      items: (changes[String(a.app_tla)] ?? []).map((ch) => ({
        number: ch.number,
        state: 'closed',
        short_description: ch.desc,
        app_tla: ch.app,
        implemented_at: ch.at,
        web_url: `http://sn.test/change_requests/${ch.number}`,
      })),
    }))
    .on('get_change_request', (a) => {
      const ch = Object.values(changes)
        .flat()
        .find((x) => x.number === a.number)!;
      return {
        number: ch.number,
        web_url: `http://sn.test/change_requests/${ch.number}`,
        merge_requests: [
          {
            reference: ch.mr,
            title: mrs[ch.mr]!.title,
            state: 'merged',
            merge_commit_sha: `sha-${ch.number}`,
            web_url: `http://gl.test/${ch.mr}`,
          },
        ],
      };
    })
    .on('get_merge_request', (a) => {
      const key = `${a.project}!${a.iid}`;
      const mr = mrs[key]!;
      return {
        project: a.project,
        iid: a.iid,
        title: mr.title,
        state: 'merged',
        author: mr.author,
        merged_at: at(5),
        merge_commit_sha: `sha-${key}`,
        web_url: `http://gl.test/${key}`,
        changes: [{ path: 'src/main/resources/application.yml', diff: mr.diff }],
      };
    })
    .on('get_commit', (a) => ({ sha: a.sha, web_url: `http://gl.test/commit/${a.sha}` }))
    .on('list_merge_requests', () => ({
      items: [
        { project: 'keybank/PRF00/prf-api', iid: 7, title: mrs['keybank/PRF00/prf-api!7']!.title },
        { project: 'keybank/PRF00/prf-api', iid: 8, title: 'Add retry to address lookup' },
      ],
    }));
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['WEB', 'MOB'],
    onset_at: onset,
  });
  c.upstream_candidates = graph.commonUpstream(c.apps);
  c.scope = {
    summary: 'Web and mobile banking failing',
    affected_apps: [
      { tla: 'WEB', name: 'Web Banking', tier: 1, services: ['web'], error_count: 300, onset },
      { tla: 'MOB', name: 'Mobile Banking', tier: 1, services: ['mob'], error_count: 200, onset },
    ],
    onset,
    signatures: [
      {
        app_tla: 'MOB',
        error_type: 'UpstreamContractError',
        message: 'profile-service: customerId missing from profile response',
        sample_insert_id: 'i1',
        stack_excerpt: '',
      },
    ],
    customer_impact: 'x',
    suggested_impact: 1,
    suggested_urgency: 1,
    severity_reason: 'x',
    log_links: [{ label: 'errors', filter: 'f', logs_url: 'http://logs.test/q' }],
    grouping: [],
  };
  return { deps, c: c as Case };
}

describe('relevance', () => {
  it('splits identifiers and ignores filler words', () => {
    expect([...tokens('customerId missing from profile_response')]).toEqual(
      expect.arrayContaining(['customer', 'customerid', 'missing', 'profile']),
    );
    expect(tokens('the error was returned').size).toBe(1); // only "returned"
  });

  it('scores diffs by overlap with the errors', () => {
    const errors = 'customerId missing from profile response';
    const culprit = changedText({
      title: mrs['keybank/PRF00/prf-api!7']!.title,
      changes: [{ path: 'a.yml', diff: mrs['keybank/PRF00/prf-api!7']!.diff }],
    });
    const bump = changedText({
      title: mrs['keybank/HUB00/hub-api!9']!.title,
      changes: [{ path: 'package.json', diff: mrs['keybank/HUB00/hub-api!9']!.diff }],
    });
    expect(relevance(culprit, errors).score).toBeGreaterThan(0);
    expect(relevance(bump, errors).score).toBe(0);
  });
});

describe('quick RCA', () => {
  it('ranks the promoted upstream change first and explains why', async () => {
    const { deps, c } = rcaCase();
    const suspects = await quickRca(deps, c);
    expect(suspects.map((s) => s.change_request?.number)).toEqual(['CHG1', 'CHG3', 'CHG2']);
    const top = suspects[0]!;
    expect(top).toMatchObject({ tla: 'PRF', author: 'jdoe', promoted_at: at(3) });
    expect(top.merge_request?.web_url).toBe('http://gl.test/keybank/PRF00/prf-api!7');
    expect(top.reason).toContain('every failing app depends on PRF');
    expect(top.confidence).toBeGreaterThan(suspects[1]!.confidence);
    // The change promoted after onset is not a suspect.
    expect(suspects.some((s) => s.change_request?.number === 'CHG4')).toBe(false);
  });
});

describe('deep RCA', () => {
  it('names the culprit with linked evidence and rules out the red herrings', async () => {
    const { deps, c } = rcaCase();
    const rc = (await heuristicDeepRca(deps, c))!;
    expect(rc.culprit_tla).toBe('PRF');
    expect(rc.change_request).toEqual({
      number: 'CHG1',
      web_url: 'http://sn.test/change_requests/CHG1',
    });
    expect(rc.merge_request?.iid).toBe(7);
    expect(rc.commit?.web_url).toBe('http://gl.test/commit/sha-keybank/PRF00/prf-api!7');
    expect(rc.files).toEqual(['src/main/resources/application.yml']);
    expect(rc.unexplained_apps).toEqual([]);
    expect(rc.mechanism).toContain('SNAKE_CASE');
    for (const e of rc.evidence) expect(e.web_url).toMatch(/^http:\/\/(sn|gl|logs)\.test\//);

    const ruled = Object.fromEntries(rc.ruled_out.map((r) => [r.ref.split(' ')[0], r.reason]));
    expect(ruled.CHG2).toContain("doesn't explain MOB");
    expect(ruled.CHG3).toContain('nothing to do with the errors');
    expect(ruled['keybank/PRF00/prf-api!8']).toContain('never promoted');
  });

  it('lists apps the root cause does not explain', async () => {
    const { deps, c } = rcaCase();
    changes.PRF = [];
    try {
      const rc = (await heuristicDeepRca(deps, c))!;
      // Without the PRF change the best remaining match is WEB's own change, which can't explain MOB.
      if (rc.culprit_tla === 'WEB') expect(rc.unexplained_apps.map((u) => u.tla)).toEqual(['MOB']);
      else expect(rc.culprit_tla).toBe('HUB');
    } finally {
      changes.PRF = [
        {
          number: 'CHG1',
          app: 'PRF',
          at: at(3),
          desc: 'profile-api: serialize customer fields in snake_case',
          mr: 'keybank/PRF00/prf-api!7',
        },
      ];
    }
  });
});

describe('deep RCA scheduling', () => {
  it('runs once per case unless forced', async () => {
    const { startDeepRca } = await import('../src/flow/steps');
    const { stepCtx } = await import('./helpers');
    const { deps, c } = rcaCase();
    const ctx = stepCtx(deps.store);
    expect(startDeepRca(deps, ctx, c)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    c.background.deep_rca = {
      state: 'done',
      started_at: '',
      finished_at: '',
      error: null,
      runs: 1,
    };
    expect(startDeepRca(deps, ctx, c)).toBe(false);
    expect(startDeepRca(deps, ctx, c, { force: true, hint: 'look at HUB' })).toBe(true);
  });
});
