/** A merge must leave one fix: background work on a merged-away case stops, and its MR is adopted. */
import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { mergeCases } from '../src/flow/regroup';
import { startFix } from '../src/flow/steps';
import { flowDeps, logSignal, stepCtx } from './helpers';

const DIFF = '@@ -1,3 +1,3 @@\n a:\n-  b: 1\n+  b: 2\n c: 3\n';

function world() {
  const deps = flowDeps();
  deps.mcp
    .on('get_merge_request', () => ({
      project: 'keybank/ABA00/routing-directory-service',
      iid: 15,
      title: 'Optimize ABA checksum validation',
      author: 'jdoe',
      state: 'merged',
      merged_at: '2026-11-11T20:40:00Z',
      merge_commit_sha: 'abc',
      web_url: 'http://gl.test/mr/15',
      changes: [{ path: 'config.yml', diff: DIFF }],
    }))
    .on('get_file', () => ({ content: 'a:\n  b: 2\nc: 3\n' }))
    .on('list_merge_requests', () => ({ items: [] }))
    .on('create_merge_request', () => ({
      iid: 16,
      state: 'opened',
      web_url: 'http://gl.test/mr/16',
    }))
    .on('add_merge_request_note', () => ({}))
    .on('update_incident', () => ({}))
    .on('link_child_incidents', () => ({}))
    .on('update_alert', () => ({}))
    .on('post_message', () => ({ id: 'm' }))
    .on('add_channel_members', () => ({}))
    .on('add_incident_note', () => ({}));
  const mk = (n: number, apps: string[], prio: number) => {
    const c = deps.store.create({
      kind: 'monitoring',
      apps,
      signals: apps.map((a) => logSignal(a)),
    }) as Case;
    c.phase = 'investigating';
    c.incident = {
      number: `INC00102${n}`,
      web_url: `http://sn.test/INC00102${n}`,
      app_tla: 'ABA',
      assignment_group: null,
      priority: prio,
    };
    c.channel = { id: `ch_${n}`, name: `inc00102${n}-x`, web_url: `http://teams.test/ch_${n}` };
    c.root_cause = {
      culprit_tla: 'ABA',
      change_request: { number: 'CHG0030081', web_url: 'http://sn.test/CHG0030081' },
      merge_request: {
        project: 'keybank/ABA00/routing-directory-service',
        iid: 15,
        title: 'x',
        web_url: 'http://gl.test/mr/15',
      },
      commit: null,
      files: ['config.yml'],
      mechanism: 'm',
      evidence: [],
      ruled_out: [],
      unexplained_apps: [],
      confidence: 0.95,
    };
    deps.store.save(c);
    return c;
  };
  return { deps, mk };
}

describe('merging cases keeps one fix', () => {
  it('a case merged away while its fix is being written opens no MR', async () => {
    const { deps, mk } = world();
    const c = mk(4, ['ACH', 'PAY'], 2);
    const ctx = stepCtx(deps.store);
    expect(startFix(deps, ctx, c)).toBe(true);
    // The other case claims it before the proposal comes back.
    c.merged_into = 'case-other';
    c.phase = 'abandoned';
    await new Promise((r) => setTimeout(r, 30));
    expect(deps.mcp.callsTo('create_merge_request')).toHaveLength(0);
    expect(c.fix_mr).toBeNull();
    expect(c.timeline.some((e) => e.text.startsWith('Fix not opened'))).toBe(true);
  });

  it('the primary adopts the fix MR the secondary already opened', async () => {
    const { deps, mk } = world();
    const primary = mk(5, ['WIR'], 1);
    const secondary = mk(4, ['ACH'], 2);
    secondary.fix_mr = {
      project: 'keybank/ABA00/routing-directory-service',
      iid: 16,
      web_url: 'http://gl.test/mr/16',
      state: 'opened',
      source_branch: 'fix/inc0010204-aba',
      merged_at: null,
      merge_commit_sha: null,
    };
    const r = await mergeCases(deps, stepCtx(deps.store), primary, secondary, 'same root cause');
    expect(r.merged).toBe(true);
    expect(primary.fix_mr?.iid).toBe(16);
  });
});
