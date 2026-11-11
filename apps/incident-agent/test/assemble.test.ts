import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import {
  assembleChannel,
  channelName,
  desiredInvites,
  priorityOf,
  syncMembers,
} from '../src/flow/assemble';
import { declared, upkeep } from '../src/flow/steps';
import { toolError } from './fakeMcp';
import { flowDeps, stepCtx } from './helpers';

function world() {
  const deps = flowDeps();
  const graph = deps.graph();
  // MBL shares OLB's support group in this test, so one person covers both.
  const mbl = graph.nodes.get('MBL')!;
  mbl.support_group = { id: 'grp_olb_support', name: 'OLB Application Support' };
  mbl.on_call = graph.nodes.get('OLB')!.on_call;

  const channels = new Map<
    string,
    { id: string; name: string; web_url: string; members: { username: string }[] }
  >();
  deps.mcp
    .on('search_support_groups', (a) => ({
      items: [
        a.type === 'noc'
          ? {
              id: 'grp_noc',
              name: 'NOC',
              on_call: { primary: { username: 'mbell' }, secondary: { username: 'bhowe' } },
            }
          : a.type === 'incident_management'
            ? { id: 'grp_mim', name: 'MIM', on_call: { primary: { username: 'orolfson2' } } }
            : {
                id: 'grp_service_desk',
                name: 'Service Desk',
                on_call: { primary: { username: 'sdesk1' } },
              },
      ],
    }))
    .on('get_merge_request', () => ({ author: 'jdoe', approved_by: ['rreviewer', 'jdoe'] }))
    .on('get_channel', (a) => {
      const ch = [...channels.values()].find((c) => c.name === a.channel || c.id === a.channel);
      return ch ?? toolError('get_channel', `Unknown channel '${a.channel}'.`);
    })
    .on('create_channel', (a) => {
      if (channels.has(String(a.name)))
        return toolError('create_channel', 'channel already exists');
      const ch = {
        id: `ch_${channels.size + 1}`,
        name: String(a.name),
        web_url: `http://teams.test/channels/ch_${channels.size + 1}`,
        members: (a.members as { user: string }[]).map((m) => ({ username: m.user })),
      };
      channels.set(ch.name, ch);
      // The real tool wraps the channel.
      return { channel: ch, notifications_sent: [] };
    })
    .on('add_channel_members', (a) => {
      const ch = [...channels.values()].find((c) => c.id === a.channel)!;
      for (const m of a.members as { user: string }[]) ch.members.push({ username: m.user });
      return { added: a.members };
    })
    .on('update_incident', () => ({}))
    .on('add_incident_note', () => ({}));

  const onset = '2026-11-11T19:14:00Z';
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL', 'TLR'],
    onset_at: onset,
  }) as Case;
  c.upstream_candidates = graph.commonUpstream(c.apps);
  c.incident = {
    number: 'INC0010234',
    web_url: 'http://sn.test/INC0010234',
    app_tla: 'CIF',
    assignment_group: 'grp_cif_support',
    priority: 1,
  };
  c.scope = {
    summary: 'Customer lookups failing across online, mobile and teller',
    affected_apps: ['OLB', 'MBL', 'TLR'].map((tla, i) => ({
      tla,
      name: tla,
      tier: 1,
      services: [],
      error_count: 300 - i * 50,
      onset,
    })),
    onset,
    signatures: [],
    customer_impact: 'x',
    suggested_impact: 1,
    suggested_urgency: 1,
    severity_reason: 'x',
    log_links: [],
    grouping: [],
  };
  c.suspects = [
    {
      tla: 'CIF',
      change_request: { number: 'CHG1', web_url: 'http://sn.test/CHG1' },
      merge_request: {
        project: 'keybank/CIF00/customer-profile-api',
        iid: 9,
        title: 'x',
        web_url: 'http://gl.test/mr/9',
      },
      promoted_at: onset,
      author: 'jdoe',
      reason: 'x',
      confidence: 0.85,
    },
  ];
  return { deps, c, channels };
}

describe('who gets invited', () => {
  it('one rep per affected team, the upstream suspect team, the change author, NOC and MIM', async () => {
    const { deps, c } = world();
    const invites = await desiredInvites(deps, c);
    const by = Object.fromEntries(invites.map((i) => [i.user, i]));
    expect(invites[0]).toMatchObject({ user: 'mbell', role: 'owner', kind: 'commander' });
    expect(by.orolfson2?.kind).toBe('mim');
    // OLB and MBL share a group: one person, both apps named.
    expect(by.aklocko2!.reason).toMatch(/on-call for OLB and MBL/);
    expect(invites.filter((i) => i.user === 'mratke')).toHaveLength(0);
    expect(by.ebradtke!.reason).toContain('TLR');
    // The upstream suspect: primary and secondary, with a reason that says why.
    expect(by.kstreich!.reason).toMatch(/no errors there, but .* depend on it/);
    expect(by.dgreen!.kind).toBe('suspect');
    // The change author and approvers, deduped.
    expect(by.jdoe!.kind).toBe('author');
    expect(by.rreviewer!.reason).toContain('approved');
    expect(new Set(invites.map((i) => i.user)).size).toBe(invites.length);
  });

  it('P3 and below get no major incident manager', async () => {
    const { deps, c } = world();
    c.scope!.suggested_impact = 2;
    c.scope!.suggested_urgency = 2;
    expect(priorityOf(2, 2)).toBe(3);
    expect((await desiredInvites(deps, c)).some((i) => i.kind === 'mim')).toBe(false);
  });
});

describe('the channel', () => {
  it('is named inc<number>-<slug>, at most 50 characters', () => {
    const name = channelName(
      'INC0010234',
      'Customer lookups failing across online, mobile and teller banking apps',
    );
    expect(name.startsWith('inc0010234-customer-lookups-failing')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it('is created once with the first people (capped), linked on the incident, and reused on re-run', async () => {
    const { deps, c, channels } = world();
    expect(await assembleChannel(deps, c)).toBe('created');
    expect(channels.size).toBe(1);
    expect(c.members.length).toBeLessThanOrEqual(deps.config.maxInvites);
    const link = deps.mcp.callsTo('update_incident').find((a) => a.add_links);
    expect(link?.add_links).toEqual([
      { type: 'teams_channel', url: c.channel!.web_url, title: `Teams #${c.channel!.name}` },
    ]);

    // A re-run after a lost save finds the channel by name instead of creating another.
    c.channel = null;
    expect(await assembleChannel(deps, c)).toBe('found');
    expect(channels.size).toBe(1);
  });

  it('adds the rep of an app that starts failing later, without a new channel', async () => {
    const { deps, c, channels } = world();
    const ctx = stepCtx(deps.store);
    expect(await declared(deps)(c, ctx)).toMatchObject({ next: 'assembled' });
    c.apps.push('PAY');
    c.scope!.affected_apps.push({
      tla: 'PAY',
      name: 'PAY',
      tier: 1,
      services: [],
      error_count: 50,
      onset: c.scope!.onset,
    });
    await upkeep(deps, c);
    expect(channels.size).toBe(1);
    expect(c.members.some((m) => m.username === 'ggrant' && m.reason.includes('PAY'))).toBe(true);
    // Nothing changed → no further calls.
    const before = deps.mcp.callsTo('add_channel_members').length;
    await upkeep(deps, c);
    expect(deps.mcp.callsTo('add_channel_members').length).toBe(before);
  });

  it('an unknown user does not block everyone else', async () => {
    const { deps, c } = world();
    await assembleChannel(deps, c);
    let calls = 0;
    deps.mcp.on('add_channel_members', (a) => {
      calls++;
      const users = (a.members as { user: string }[]).map((m) => m.user);
      return users.includes('ghost')
        ? toolError('add_channel_members', 'Unknown user ghost. Did you mean ghosh?')
        : { added: a.members };
    });
    const added = await syncMembers(deps, c, {
      extra: [
        { user: 'ghost', reason: 'x', role: 'member', kind: 'other', priority: 9 },
        { user: 'realperson', reason: 'DBA on-call', role: 'member', kind: 'other', priority: 9 },
      ],
    });
    expect(added.map((i) => i.user)).toContain('realperson');
    expect(added.map((i) => i.user)).not.toContain('ghost');
    expect(calls).toBeGreaterThan(1);
  });
});
