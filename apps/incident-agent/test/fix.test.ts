import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import {
  fixBranch,
  openFixMr,
  parseHunks,
  revertEdits,
  revertProposal,
  validateFix,
} from '../src/flow/fix';
import { fixProposed, investigating } from '../src/flow/steps';
import { flowDeps, stepCtx } from './helpers';

const DIFF = `@@ -24,7 +24,7 @@
 spring:
   jackson:
     default-property-inclusion: non_null
-    property-naming-strategy: LOWER_CAMEL_CASE
+    property-naming-strategy: SNAKE_CASE
 
 cif:
   cache-ttl: 300s
`;

const MAIN = `server:
  port: 8080
spring:
  jackson:
    default-property-inclusion: non_null
    property-naming-strategy: SNAKE_CASE

cif:
  cache-ttl: 300s
  page-size: 50
`;

describe('reverting a diff', () => {
  it('parses hunks into old and new sides', () => {
    const [h] = parseHunks(DIFF);
    expect(h!.newText).toContain('property-naming-strategy: SNAKE_CASE');
    expect(h!.oldText).toContain('property-naming-strategy: LOWER_CAMEL_CASE');
    expect(h!.oldText).not.toContain('SNAKE_CASE');
  });

  it('builds a find/replace that matches exactly once on main', () => {
    const { edits, problems } = revertEdits('application.yml', DIFF, MAIN);
    expect(problems).toEqual([]);
    expect(edits).toHaveLength(1);
    const applied = MAIN.replace(edits[0]!.find!, edits[0]!.replace!);
    expect(applied).toContain('property-naming-strategy: LOWER_CAMEL_CASE');
    expect(applied).not.toContain('SNAKE_CASE');
  });

  it('falls back to just the changed lines when the context drifted', () => {
    const drifted = MAIN.replace('cache-ttl: 300s', 'cache-ttl: 600s');
    const { edits, problems } = revertEdits('application.yml', DIFF, drifted);
    expect(problems).toEqual([]);
    expect(edits[0]!.find).toBe('    property-naming-strategy: SNAKE_CASE');
  });

  it('refuses an ambiguous revert', () => {
    const twice = `${MAIN}\nother:\n    property-naming-strategy: SNAKE_CASE\n`;
    const drifted = twice.replace('cache-ttl: 300s', 'cache-ttl: 600s');
    const { edits, problems } = revertEdits('application.yml', DIFF, drifted);
    expect(edits).toHaveLength(0);
    expect(problems[0]).toContain('not found exactly once');
  });
});

function world() {
  const deps = flowDeps();
  const mrs: Record<string, unknown>[] = [];
  deps.mcp
    .on('get_merge_request', (a) =>
      a.iid === 9
        ? {
            project: 'keybank/CIF00/customer-profile-api',
            iid: 9,
            title: 'Adopt enterprise API naming standard (snake_case)',
            author: 'jdoe',
            state: 'merged',
            merged_at: '2026-11-11T19:10:00Z',
            merge_commit_sha: 'abc',
            web_url: 'http://gl.test/cif/mr/9',
            changes: [{ path: 'src/main/resources/application.yml', diff: DIFF }],
          }
        : mrs.find((m) => m.iid === a.iid),
    )
    .on('get_file', (a) =>
      a.path === 'src/main/resources/application.yml' ? { content: MAIN } : new Error('404'),
    )
    .on('list_merge_requests', () => ({ items: mrs }))
    .on('create_merge_request', (a) => {
      const mr = {
        ...a,
        iid: 10 + mrs.length,
        state: 'opened',
        web_url: `http://gl.test/cif/mr/${10 + mrs.length}`,
      };
      mrs.push(mr);
      return mr;
    })
    .on('add_merge_request_note', () => ({}))
    .on('update_incident', () => ({}))
    .on('add_incident_note', () => ({}))
    .on('post_message', () => ({ id: 'm' }));
  const c = deps.store.create({ kind: 'monitoring', apps: ['OLB', 'MBL'] }) as Case;
  c.incident = {
    number: 'INC0010234',
    web_url: 'http://sn.test/INC0010234',
    app_tla: 'CIF',
    assignment_group: null,
    priority: 1,
  };
  c.channel = { id: 'ch_1', name: 'inc0010234-x', web_url: 'http://teams.test/ch_1' };
  c.root_cause = {
    culprit_tla: 'CIF',
    change_request: { number: 'CHG0030081', web_url: 'http://sn.test/CHG0030081' },
    merge_request: {
      project: 'keybank/CIF00/customer-profile-api',
      iid: 9,
      title: 'x',
      web_url: 'http://gl.test/cif/mr/9',
    },
    commit: null,
    files: ['src/main/resources/application.yml'],
    mechanism: 'snake_case breaks callers',
    evidence: [{ claim: 'promoted at 19:12', web_url: 'http://sn.test/CHG0030081' }],
    ruled_out: [],
    unexplained_apps: [],
    confidence: 0.9,
  };
  return { deps, c, mrs };
}

describe('the fix proposal', () => {
  it('reverts the culprit MR with an incident title and a useful description', async () => {
    const { deps, c } = world();
    const { fix, problems } = await revertProposal(deps, c);
    expect(problems).toEqual([]);
    expect(fix).toMatchObject({
      project: 'keybank/CIF00/customer-profile-api',
      strategy: 'revert',
    });
    expect(fix!.title).toBe(
      'Revert "Adopt enterprise API naming standard (snake_case)" (INC0010234)',
    );
    expect(fix!.description).toContain('[INC0010234](http://sn.test/INC0010234)');
    expect(fix!.description).toContain('http://sn.test/CHG0030081');
    expect(fix!.description).toContain('How to verify');
    expect(await validateFix(deps, c, fix!, ['src/main/resources/application.yml'])).toEqual([]);
  });

  it('validation rejects foreign files and non-unique finds', async () => {
    const { deps, c } = world();
    const problems = await validateFix(
      deps,
      c,
      {
        project: 'keybank/CIF00/customer-profile-api',
        strategy: 'forward-fix',
        justification: 'x',
        title: 't',
        description: 'd',
        changes: [
          { path: 'src/main/resources/application.yml', find: 'cif:', replace: 'x' },
          { path: 'src/main/resources/application.yml', find: '  ', replace: 'x' },
          { path: 'pom.xml', find: 'x', replace: 'y' },
        ],
      },
      ['src/main/resources/application.yml'],
    );
    expect(problems.join(' ')).toContain('occurs');
    expect(problems.join(' ')).toContain('pom.xml is not part of the culprit change');
  });
});

describe('opening the MR', () => {
  it('opens one MR on fix/inc<number>-…, notes the culprit MR and links the incident', async () => {
    const { deps, c, mrs } = world();
    const { fix } = await revertProposal(deps, c);
    expect(await openFixMr(deps, c, fix!)).toBe('created');
    expect(mrs).toHaveLength(1);
    expect(mrs[0]).toMatchObject({
      source_branch: fixBranch(c),
      target_branch: 'main',
      labels: ['incident', 'revert'],
    });
    expect(fixBranch(c)).toBe('fix/inc0010234-cif');
    expect(deps.mcp.callsTo('add_merge_request_note')[0]).toMatchObject({ iid: 9 });
    expect(deps.mcp.callsTo('update_incident').at(-1)!.add_links).toEqual([
      {
        type: 'merge_request',
        url: 'http://gl.test/cif/mr/10',
        title: 'Fix: keybank/CIF00/customer-profile-api!10',
      },
    ]);
    c.fix_mr = null; // lost save
    expect(await openFixMr(deps, c, fix!)).toBe('found');
    expect(mrs).toHaveLength(1);
  });

  it('investigating starts the fix in the background, then the review request goes out', async () => {
    const { deps, c } = world();
    const ctx = stepCtx(deps.store);
    c.phase = 'investigating';
    await investigating(deps)(c, ctx);
    expect(ctx.spawned).toContain('fix');
    await new Promise((r) => setTimeout(r, 30));
    expect(c.fix_mr?.iid).toBe(10);
    expect(await investigating(deps)(c, ctx)).toMatchObject({ next: 'fix_proposed' });
    expect(await fixProposed(deps)(c, ctx)).toMatchObject({ next: 'awaiting_merge' });
    const post = deps.mcp.callsTo('post_message').at(-1)!;
    expect(String(post.body)).toContain('Fix ready for review');
    expect(String(post.body)).toContain('@jdoe');
    expect(String(post.body)).toContain('click **Merge**');
  });
});
