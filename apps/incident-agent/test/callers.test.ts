import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { caseVocabulary, groupCallers, heuristicVerdict } from '../src/flow/callers';
import { flowDeps } from './helpers';

const onset = '2026-11-11T19:14:00.000Z';
const at = (min: number) => new Date(Date.parse(onset) + min * 60_000).toISOString();

function world() {
  const deps = flowDeps();
  const linked: string[][] = [];
  const rows = [
    {
      number: 'INC0010240',
      short_description: 'Teller workstation customer lookup fails - Akron',
      opened_at: at(2),
      contact_type: 'phone',
      app_tla: null,
    },
    {
      number: 'INC0010241',
      short_description: 'Cannot pull up customer profile at the teller window',
      opened_at: at(3),
      contact_type: 'chat',
      app_tla: 'TLR',
    },
    {
      number: 'INC0010242',
      short_description: 'Branch workstation KBW18244 will not boot',
      opened_at: at(4),
      contact_type: 'phone',
      app_tla: 'BAS',
      category: 'hardware',
    },
    {
      number: 'INC0010199',
      short_description: 'Password reset for online banking',
      opened_at: at(-40),
      contact_type: 'email',
      app_tla: null,
    },
    {
      number: 'INC0010243',
      short_description: 'Printer out of toner on 3rd floor',
      opened_at: at(5),
      contact_type: 'email',
      app_tla: null,
    },
  ];
  deps.mcp
    .on('list_incidents', () => ({ items: rows }))
    .on('get_incident', (a) => ({
      description:
        a.number === 'INC0010240' ? 'Tellers get an error when looking up customer profiles.' : '',
      category: rows.find((r) => r.number === a.number)?.category,
    }))
    .on('link_child_incidents', (a) => {
      linked.push(a.children as string[]);
      return {};
    })
    .on('update_incident', () => ({}));
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL', 'TLR'],
    onset_at: onset,
  }) as Case;
  c.incident = {
    number: 'INC0010234',
    web_url: 'http://sn.test/INC0010234',
    app_tla: 'CIF',
    assignment_group: null,
    priority: 1,
  };
  c.scope = {
    summary: 'Customer profile lookups failing in online, mobile and teller banking',
    affected_apps: [
      { tla: 'OLB', name: 'Online Banking', tier: 1, services: [], error_count: 800, onset },
      { tla: 'MBL', name: 'Mobile Banking', tier: 1, services: [], error_count: 500, onset },
      { tla: 'TLR', name: 'Teller Workstation', tier: 1, services: [], error_count: 100, onset },
    ],
    onset,
    signatures: [
      {
        app_tla: 'MBL',
        error_type: 'UpstreamContractError',
        message: 'customer-profile-api: customerId missing from profile response',
        sample_insert_id: 'i',
        stack_excerpt: '',
      },
    ],
    customer_impact: 'Customers and tellers cannot load customer profiles.',
    suggested_impact: 1,
    suggested_urgency: 1,
    severity_reason: 'x',
    log_links: [],
    grouping: [],
  };
  return { deps, c, linked };
}

describe('caller grouping', () => {
  it('groups the teller calls and leaves background incidents alone', async () => {
    const { deps, c, linked } = world();
    const { added, rejected } = await groupCallers(deps, c);
    expect(added.map((a) => a.number).sort()).toEqual(['INC0010240', 'INC0010241']);
    expect(linked).toEqual([['INC0010240', 'INC0010241']]);
    const why = Object.fromEntries(rejected.map((r) => [r.number, r.reason]));
    expect(why.INC0010242).toContain('hardware');
    expect(why.INC0010199).toContain('before the problem started');
    expect(why.INC0010243).toBeDefined();
    expect(c.children.sort()).toEqual(['INC0010240', 'INC0010241']);
    // The caller-visible comment goes on the parent the first time.
    expect(deps.mcp.callsTo('update_incident')[0]!.comment).toContain("We're aware");
    const link = deps.mcp.callsTo('link_child_incidents')[0]!;
    expect(String(link.child_comment)).toContain('INC0010234');
  });

  it('does not ask twice about the same call', async () => {
    const { deps, c, linked } = world();
    await groupCallers(deps, c);
    await groupCallers(deps, c);
    expect(linked).toHaveLength(1);
  });

  it('uses the app on the call and the case vocabulary', () => {
    const { deps, c } = world();
    const vocab = caseVocabulary(deps, c);
    expect(vocab.has('teller')).toBe(true);
    expect(vocab.has('profile')).toBe(true);
    expect(
      heuristicVerdict(
        deps,
        c,
        { number: 'X', short_description: 'anything', opened_at: at(1), app_tla: 'OLB' },
        vocab,
      ).related,
    ).toBe(true);
    expect(
      heuristicVerdict(
        deps,
        c,
        {
          number: 'Y',
          short_description: 'Receipt printer prints the wrong date',
          opened_at: at(1),
        },
        vocab,
      ).related,
    ).toBe(false);
  });
});

describe('upkeep groups calls and tells the channel', () => {
  it('queues a grouping summary and re-checks only on new calls or after the interval', async () => {
    const { upkeep } = await import('../src/flow/steps');
    const { deps, c } = world();
    deps.mcp.on('post_message', () => ({ id: 'm' })).on('add_incident_note', () => ({}));
    c.channel = { id: 'ch_1', name: 'inc0010234-x', web_url: 'http://teams.test/ch_1' };
    c.milestones['announce:briefing'] = new Date().toISOString();
    c.milestones.members_key = 'skip';
    await upkeep(deps, c);
    expect(c.children.length).toBe(2);
    // Nothing was posted recently, so the update goes out right away.
    const posted = deps.mcp.callsTo('post_message').map((p) => String(p.body));
    expect(posted.some((b) => b.includes('Grouped 2 calls'))).toBe(true);
    expect(c.milestones['announce:callers:INC0010240,INC0010241']).toBeDefined();
    const lists = deps.mcp.callsTo('list_incidents').length;
    await upkeep(deps, c);
    expect(deps.mcp.callsTo('list_incidents').length).toBe(lists); // throttled
  });
});
