import type { ActivityEvent, ActivityTailResult } from '@sim/contracts/servicenow';
import { describe, expect, it } from 'vitest';
import type { AlertSignal, HumanSignal } from '../src/cases/types';
import { silent } from '../src/log';
import { AlertPoller } from '../src/watchers/alerts';
import { ServiceNowFeed } from '../src/watchers/serviceNowFeed';
import { FakeMcp } from './fakeMcp';

const user = (username: string) => ({
  username,
  name: username,
  email: `${username}@keybank.example`,
  web_url: `http://sn/users/${username}`,
});

function opened(
  seq: number,
  number: string,
  over: { author?: string; contact?: string; caller?: string; app?: string | null } = {},
): ActivityEvent {
  const author = over.author ?? 'mlopez';
  return {
    seq,
    kind: 'incident.opened',
    table: 'incident',
    number,
    app_tla: over.app ?? null,
    at: `2026-11-11T19:0${seq}:00Z`,
    entry: {
      id: `j${seq}`,
      type: 'system',
      text: 'Incident opened via Phone',
      author: user(author),
      created_at: `2026-11-11T19:0${seq}:00Z`,
    },
    incident: {
      sys_id: number,
      number,
      short_description: `Teller lookups failing at branch ${seq}`,
      web_url: `http://sn/incidents/${number}`,
      state: 'new',
      priority: 3,
      impact: 2,
      urgency: 2,
      category: 'application',
      app: over.app ? { tla: over.app, name: over.app, tier: 1, web_url: '' } : null,
      assignment_group: null,
      assigned_to: null,
      caller: user(over.caller ?? author),
      contact_type: (over.contact ?? 'phone') as never,
      opened_at: '',
      updated_at: '',
      resolved_at: null,
      parent_incident: null,
      child_count: 0,
    },
  };
}

function tailScript(pages: Partial<ActivityTailResult>[]) {
  const calls: Record<string, string>[] = [];
  return {
    calls,
    tail: async (params: Record<string, string>): Promise<ActivityTailResult> => {
      calls.push(params);
      const page = pages.shift() ?? {};
      return { items: [], cursor: 0, last_seq: 0, epoch: 1, has_more: false, ...page };
    },
  };
}

function mcp() {
  return new FakeMcp()
    .on('get_incident', (a) => ({ number: a.number, description: `Details for ${a.number}` }))
    .on('get_user', (a) => ({ username: a.username, location: 'Cleveland Main Branch' }));
}

describe('ServiceNowFeed', () => {
  it('turns calls from people into human signals and ignores our own incidents', async () => {
    const { tail, calls } = tailScript([
      { last_seq: 10, cursor: 10, epoch: 7 },
      {
        epoch: 7,
        cursor: 13,
        last_seq: 13,
        items: [
          opened(1, 'INC0010201', { app: 'TLR' }),
          opened(2, 'INC0010202', { author: 'svc_incident_auto', contact: 'monitoring' }),
          opened(3, 'INC0010203', { contact: 'self_service' }),
        ],
      },
    ]);
    const humans: HumanSignal[] = [];
    const feed = new ServiceNowFeed(tail, mcp(), 'svc_incident_auto', silent, {
      onHuman: (s) => humans.push(s),
      onIncidentEvent: () => {},
      onReset: () => {},
      owns: () => false,
    });
    await feed.poll(0);
    expect(calls[0]).toEqual({ limit: '1' }); // starts live at the head
    expect(calls[1]).toMatchObject({ after_seq: '10', table: 'incident' });
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({
      source: 'human',
      incident_number: 'INC0010201',
      caller: 'mlopez',
      location: 'Cleveland Main Branch',
      contact_type: 'phone',
      app_tla: 'TLR',
      description: 'Details for INC0010201',
    });
    expect(feed.cursor).toBe(13);
  });

  it('never turns the agent’s own incidents into signals, even with a human contact type', async () => {
    const { tail } = tailScript([
      { last_seq: 0, cursor: 0, epoch: 1 },
      {
        items: [opened(1, 'INC0010300', { author: 'svc_incident_auto', contact: 'phone' })],
        cursor: 1,
        last_seq: 1,
      },
    ]);
    const humans: HumanSignal[] = [];
    const feed = new ServiceNowFeed(tail, mcp(), 'svc_incident_auto', silent, {
      onHuman: (s) => humans.push(s),
      onIncidentEvent: () => {},
      onReset: () => {},
      owns: () => true,
    });
    await feed.poll(0);
    expect(humans).toHaveLength(0);
  });

  it('forwards human updates on incidents a case owns', async () => {
    const update: ActivityEvent = {
      ...opened(4, 'INC0010205'),
      kind: 'incident.comment',
      entry: {
        id: 'j',
        type: 'comment',
        text: 'Still broken at Akron',
        author: user('kbrandt'),
        created_at: '',
      },
    };
    const ours: ActivityEvent = {
      ...update,
      entry: { ...update.entry, author: user('svc_incident_auto') },
    };
    const other: ActivityEvent = { ...update, number: 'INC0099999' };
    const { tail } = tailScript([
      { last_seq: 0, cursor: 0, epoch: 1 },
      { items: [update, ours, other], cursor: 3, last_seq: 3 },
    ]);
    const forwarded: ActivityEvent[] = [];
    const feed = new ServiceNowFeed(tail, mcp(), 'svc_incident_auto', silent, {
      onHuman: () => {},
      onIncidentEvent: (e) => forwarded.push(e),
      onReset: () => {},
      owns: (n) => n === 'INC0010205',
    });
    await feed.poll(0);
    expect(forwarded.map((e) => e.entry.text)).toEqual(['Still broken at Akron']);
  });

  it('reports a world reset when the epoch changes and resumes live', async () => {
    const { tail } = tailScript([
      { last_seq: 500, cursor: 500, epoch: 1 },
      { epoch: 2, last_seq: 40, cursor: 40, items: [opened(1, 'INC0010001')] },
    ]);
    let resets = 0;
    const humans: HumanSignal[] = [];
    const feed = new ServiceNowFeed(tail, mcp(), 'svc_incident_auto', silent, {
      onHuman: (s) => humans.push(s),
      onIncidentEvent: () => {},
      onReset: () => resets++,
      owns: () => false,
    });
    await feed.poll(0);
    expect(resets).toBe(1);
    expect(humans).toHaveLength(0); // the reseeded baseline is not replayed
    expect(feed.cursor).toBe(40);
    expect(feed.epoch).toBe(2);
  });
});

describe('AlertPoller', () => {
  const alert = (id: number, minutesAgo: number, app = 'CRD') => ({
    id,
    severity: 'critical',
    status: 'open',
    description: `HTTP 5xx rate on ${app}`,
    app_tla: app,
    service: `${app.toLowerCase()}-api`,
    first_event_time: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    web_url: `http://logs/alerts/${id}`,
  });

  it('treats old open alerts as background and emits new ones once', async () => {
    let current = [alert(1, 90, 'TMA'), alert(2, 1)];
    const fake = new FakeMcp().on('list_alerts', () => ({ items: current }));
    const signals: AlertSignal[] = [];
    const poller = new AlertPoller(fake, silent, (s) => signals.push(s));
    await poller.poll();
    expect(signals.map((s) => s.alert_id)).toEqual([2]); // 1 was already open long ago
    current = [...current, alert(3, 0, 'OLB')];
    await poller.poll();
    await poller.poll();
    expect(signals.map((s) => s.alert_id)).toEqual([2, 3]);
    expect(signals[1]).toMatchObject({
      source: 'alert',
      app_tla: 'OLB',
      web_url: 'http://logs/alerts/3',
    });
    expect(fake.callsTo('list_alerts').at(-1)).toMatchObject({ status: ['open'] });
  });
});
