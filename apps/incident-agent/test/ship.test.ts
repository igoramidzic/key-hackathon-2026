import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { checkMerge, followChange, raiseChange, tlaOfProject } from '../src/flow/ship';
import { awaitingMerge, shipping } from '../src/flow/steps';
import { flowDeps, stepCtx } from './helpers';

function world() {
  const deps = flowDeps();
  const state = { mr: 'opened', merged_at: null as string | null };
  const changes: Record<string, unknown>[] = [];
  let change: {
    state: string;
    deployments: { deployed_at: string }[];
    journal: { text: string; author: { username: string } }[];
  } = {
    state: 'scheduled',
    deployments: [],
    journal: [],
  };
  deps.mcp
    .on('get_merge_request', () => ({
      project: 'keybank/CIF00/customer-profile-api',
      iid: 10,
      title: 'Revert x',
      state: state.mr,
      merged_at: state.merged_at,
      merged_by: 'dwhitfield',
      merge_commit_sha: state.mr === 'merged' ? 'fixsha' : null,
      author: 'svc_incident_auto',
      web_url: 'http://gl.test/mr/10',
    }))
    .on('list_change_requests', () => ({
      items: changes.map((c) => ({ number: c.number, state: 'scheduled', web_url: c.web_url })),
    }))
    .on('create_change_request', (a) => {
      const ch = {
        ...a,
        number: `CHG00300${90 + changes.length}`,
        state: 'scheduled',
        web_url: `http://sn.test/change_requests/CHG00300${90 + changes.length}`,
      };
      changes.push(ch);
      return ch;
    })
    .on('get_change_request', () => ({
      number: 'CHG0030090',
      web_url: 'http://sn.test/change_requests/CHG0030090',
      merge_requests: [],
      ...change,
    }))
    .on('update_change_request', (a) => {
      change = { ...change, state: 'scheduled' };
      return { number: a.number };
    })
    .on('update_incident', () => ({}))
    .on('add_incident_note', () => ({}))
    .on('post_message', () => ({ id: 'm' }));
  const c = deps.store.create({ kind: 'monitoring', apps: ['OLB'] }) as Case;
  c.phase = 'awaiting_merge';
  c.incident = {
    number: 'INC0010234',
    web_url: 'http://sn.test/INC0010234',
    app_tla: 'CIF',
    assignment_group: null,
    priority: 1,
  };
  c.channel = { id: 'ch_1', name: 'inc0010234-x', web_url: 'http://teams.test/ch_1' };
  c.fix_mr = {
    project: 'keybank/CIF00/customer-profile-api',
    iid: 10,
    web_url: 'http://gl.test/mr/10',
    state: 'opened',
    source_branch: 'fix/inc0010234-cif',
    merged_at: null,
    merge_commit_sha: null,
  };
  c.fix = {
    project: 'keybank/CIF00/customer-profile-api',
    strategy: 'revert',
    justification: 'self-contained',
    changes: [{ path: 'a', find: 'b', replace: 'c' }],
    title: 'Revert "x" (INC0010234)',
    description: 'd',
  };
  return {
    deps,
    c,
    changes,
    merge: () => {
      state.mr = 'merged';
      state.merged_at = new Date().toISOString();
    },
    close: () => {
      state.mr = 'closed';
    },
    setChange: (next: typeof change) => {
      change = next;
    },
  };
}

describe('watching the merge', () => {
  it('maps projects to their app', () => {
    expect(tlaOfProject('keybank/CIF00/customer-profile-api')).toBe('CIF');
    expect(tlaOfProject('nope')).toBeNull();
  });

  it('waits while open, then records the merge', async () => {
    const { deps, c, merge } = world();
    expect(await checkMerge(deps, c)).toBe('opened');
    merge();
    expect(await checkMerge(deps, c)).toBe('merged');
    expect(c.fix_mr).toMatchObject({ state: 'merged', merge_commit_sha: 'fixsha' });
  });

  it('awaiting_merge moves to shipping on merge, and asks what is wrong when the MR is closed', async () => {
    const { deps, c, merge, close } = world();
    const ctx = stepCtx(deps.store);
    expect(await awaitingMerge(deps)(c, ctx)).toMatchObject({ wait: expect.any(Number) });
    merge();
    expect(await awaitingMerge(deps)(c, ctx)).toMatchObject({ next: 'shipping' });

    const other = world();
    other.close();
    expect(await awaitingMerge(other.deps)(other.c, stepCtx(other.deps.store))).toMatchObject({
      next: 'investigating',
    });
    const asked = other.deps.mcp.callsTo('post_message').at(-1)!;
    expect(String(asked.body)).toContain('closed without merging');
    expect(close).toBeTypeOf('function');
  });
});

describe('the emergency change', () => {
  it('is raised once with the fix MR, now, emergency, linked to the incident', async () => {
    const { deps, c, changes } = world();
    expect(await raiseChange(deps, c)).toBe('created');
    expect(changes[0]).toMatchObject({
      app_tla: 'CIF',
      merge_requests: ['keybank/CIF00/customer-profile-api!10'],
      planned_start: 'now',
      type: 'emergency',
      related_incidents: ['INC0010234'],
    });
    c.change = null;
    expect(await raiseChange(deps, c)).toBe('found');
    expect(changes).toHaveLength(1);
  });

  it('follows KBR to the deploy', async () => {
    const { deps, c, setChange } = world();
    await raiseChange(deps, c);
    expect(await followChange(deps, c)).toEqual({ status: 'waiting' });
    setChange({
      state: 'closed',
      deployments: [{ deployed_at: '2026-11-11T19:30:00Z' }],
      journal: [],
    });
    expect(await followChange(deps, c)).toEqual({ status: 'deployed', at: '2026-11-11T19:30:00Z' });
    expect(c.change?.deployed_at).toBe('2026-11-11T19:30:00Z');
  });

  it('recovers from a KBR abort once the MR is merged', async () => {
    const { deps, c, setChange, merge } = world();
    await raiseChange(deps, c);
    setChange({
      state: 'new',
      deployments: [],
      journal: [
        {
          text: 'Aborted: keybank/CIF00/customer-profile-api!10 is not merged',
          author: { username: 'svc_kbr' },
        },
      ],
    });
    expect(await followChange(deps, c)).toMatchObject({ status: 'aborted' });
    merge();
    expect(await followChange(deps, c)).toMatchObject({ status: 'retried' });
    expect(deps.mcp.callsTo('update_change_request')[0]).toMatchObject({
      number: 'CHG0030090',
      planned_start: 'now',
    });
  });

  it('shipping posts the change, then the promotion, and moves to verifying', async () => {
    const { deps, c, merge, setChange } = world();
    merge();
    await checkMerge(deps, c);
    c.phase = 'shipping';
    const ctx = stepCtx(deps.store);
    expect(await shipping(deps)(c, ctx)).toMatchObject({ wait: expect.any(Number) });
    expect(String(deps.mcp.callsTo('post_message').at(-1)!.body)).toContain('Emergency change');
    setChange({
      state: 'closed',
      deployments: [{ deployed_at: new Date().toISOString() }],
      journal: [],
    });
    expect(await shipping(deps)(c, ctx)).toMatchObject({ next: 'verifying' });
    expect(String(deps.mcp.callsTo('post_message').at(-1)!.body)).toContain('KBR promoted');
  });
});
