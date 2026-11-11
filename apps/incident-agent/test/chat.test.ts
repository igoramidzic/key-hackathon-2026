import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import {
  type ChatHooks,
  type ChatMessage,
  classify,
  handleMessage,
  pollChat,
} from '../src/flow/chat';
import { flowDeps } from './helpers';

const TLAS = new Set(['CIF', 'OLB', 'MBL', 'ATH']);

describe('classifying channel messages', () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ['what changed in CIF in the last 6h?', 'question', { tla: 'CIF', hours: 6 }],
    ['Any idea why mobile is still slow?', 'question'],
    ["it's not that MR, look at the ATH deploy from this morning", 'correction', { tla: 'ATH' }],
    ["I'll take this one", 'ownership'],
    ['merged it', 'merged'],
    ['Merged the fix 👍', 'merged'],
    ['can you merge it for me?', 'destructive'],
    ['please delete the channel', 'destructive'],
    [
      'OLB is unrelated, that is a separate certificate problem',
      'regroup',
      { regroup: 'split', tla: 'OLB' },
    ],
    ['this is the same as INC0010205', 'regroup', { regroup: 'merge', incident: 'INC0010205' }],
    ['thanks all', 'other'],
  ];
  for (const [text, intent, extra] of cases) {
    it(`"${text}" → ${intent}`, () => {
      const c = classify(text, TLAS);
      expect(c.intent).toBe(intent);
      if (extra) expect(c).toMatchObject(extra);
    });
  }
});

function world() {
  const deps = flowDeps();
  const posts: Record<string, unknown>[] = [];
  deps.mcp
    .on('post_message', (a) => {
      posts.push(a);
      return { id: `msg_${posts.length + 100}` };
    })
    .on('update_incident', () => ({}))
    .on('add_incident_note', () => ({}))
    .on('list_change_requests', () => ({
      items: [
        {
          number: 'CHG0030081',
          state: 'closed',
          short_description: 'customer-profile-api: Adopt naming standard',
          app_tla: 'CIF',
          implemented_at: '2026-11-11T19:12:00Z',
          web_url: 'http://sn.test/CHG0030081',
        },
      ],
    }))
    .on('list_merge_requests', () => ({
      items: [
        {
          project: 'keybank/CIF00/customer-profile-api',
          iid: 9,
          title: 'Adopt naming standard',
          merged_at: '2026-11-11T19:05:00Z',
          web_url: 'http://gl.test/mr/9',
          state: 'merged',
          author: 'jdoe',
          merge_commit_sha: 'a',
        },
        {
          project: 'keybank/CIF00/customer-profile-api',
          iid: 8,
          title: 'Tidy logging',
          merged_at: '2026-11-11T18:00:00Z',
          web_url: 'http://gl.test/mr/8',
          state: 'merged',
          author: 'x',
          merge_commit_sha: 'b',
        },
      ],
    }));
  const c = deps.store.create({ kind: 'monitoring', apps: ['OLB'] }) as Case;
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
    source_branch: 'fix/x',
    merged_at: null,
    merge_commit_sha: null,
  };
  const calls: string[] = [];
  const hooks: ChatHooks = {
    rerunRca: (_c, hint) => calls.push(`rca:${hint}`),
    checkMerge: () => calls.push('merge'),
    regroup: async (_c, r) => {
      calls.push(`regroup:${r.kind}:${r.tla ?? r.incident}`);
      return 'ok';
    },
  };
  return { deps, c, posts, calls, hooks };
}

const msg = (body: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `msg_${Math.random().toString(36).slice(2, 7)}`,
  author: 'kstreich',
  kind: 'message',
  created_at: new Date().toISOString(),
  body,
  ...over,
});

describe('reacting to the channel', () => {
  it('answers "what changed in <TLA>" with linked changes and QV-only merges, in a thread', async () => {
    const { deps, c, posts, hooks } = world();
    const m = msg('what changed in CIF in the last 6h?');
    expect(await handleMessage(deps, c, m, hooks)).toBe('question');
    const reply = posts[0]!;
    expect(reply.reply_to_id).toBe(m.id);
    expect(String(reply.body)).toContain('[CHG0030081](http://sn.test/CHG0030081)');
    expect(String(reply.body)).toContain(
      '[keybank/CIF00/customer-profile-api!8](http://gl.test/mr/8)',
    );
    expect(String(reply.body)).not.toContain('!9]'); // promoted, listed under the change
  });

  it('never merges on request: it says what to click', async () => {
    const { deps, c, posts, calls, hooks } = world();
    await handleMessage(deps, c, msg('can you merge it for me?'), hooks);
    expect(String(posts[0]!.body)).toContain("I can't merge");
    expect(String(posts[0]!.body)).toContain('http://gl.test/mr/10');
    expect(calls).toEqual([]);
    expect(deps.mcp.calls.some((x) => /merge_request$|create_|delete/.test(x.tool))).toBe(false);
  });

  it('re-runs the root cause on a correction and assigns on ownership', async () => {
    const { deps, c, calls, hooks } = world();
    await handleMessage(deps, c, msg("it's not that MR, look at the ATH deploy"), hooks);
    expect(calls[0]).toBe("rca:it's not that MR, look at the ATH deploy");
    await handleMessage(deps, c, msg("I'm on it", { author: 'aklocko2' }), hooks);
    expect(deps.mcp.callsTo('update_incident').at(-1)).toMatchObject({ assigned_to: 'aklocko2' });
  });

  it('checks the MR when someone says it is merged, and passes regroup requests on', async () => {
    const { deps, c, calls, hooks } = world();
    await handleMessage(deps, c, msg('merged it'), hooks);
    await handleMessage(deps, c, msg('OLB is unrelated'), hooks);
    expect(calls).toEqual(['merge', 'regroup:split:OLB']);
  });

  it('polls new messages only, skipping its own and system messages', async () => {
    const { deps, c, posts, hooks } = world();
    let page: ChatMessage[] = [
      msg('briefing', {
        id: 'msg_1',
        author: 'svc_incident_auto',
        created_at: '2026-11-11T19:20:00Z',
      }),
      msg('Priya joined', {
        id: 'msg_2',
        author: 'priya',
        kind: 'system',
        created_at: '2026-11-11T19:20:01Z',
      }),
      msg('thanks all', { id: 'msg_3', created_at: '2026-11-11T19:20:02Z' }),
      msg('what is the status?', { id: 'msg_4', created_at: '2026-11-11T19:20:03Z' }),
    ];
    deps.mcp.on('read_messages', () => ({ items: page }));
    expect(await pollChat(deps, c, hooks)).toBe(2);
    expect(c.chat_cursor).toBe('msg_4');
    expect(posts).toHaveLength(1); // only the question gets an answer
    expect(String(posts[0]!.body)).toContain('**Status:**');
    page = [];
    expect(await pollChat(deps, c, hooks)).toBe(0);
    expect(deps.mcp.callsTo('read_messages').at(-1)).toMatchObject({ since: 'msg_4' });
  });
});
