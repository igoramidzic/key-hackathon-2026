import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import {
  draftCommunication,
  endMeeting,
  et,
  fallbackText,
  openProblem,
  problemChannelName,
  processText,
  renameForProblem,
  resolutionFields,
  startMeeting,
  syncIncidentRecord,
  systemsImpacted,
} from '../src/flow/process';
import { writeResolution } from '../src/flow/verify';
import * as T from '../src/messages/teams';
import { toolError } from './fakeMcp';
import { flowDeps } from './helpers';

const onset = '2026-11-11T19:14:00.000Z';

function world(env: Record<string, string> = {}) {
  const deps = flowDeps({ env });
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL'],
    onset_at: onset,
  }) as Case;
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
  c.members = [{ username: 'mbell', reason: 'incident commander', role: 'owner' }];
  c.scope = {
    summary: 'Customer lookups failing',
    affected_apps: [
      { tla: 'OLB', name: 'Online Banking', tier: 1, services: [], error_count: 900, onset },
      { tla: 'MBL', name: 'Mobile Banking', tier: 1, services: [], error_count: 400, onset },
    ],
    onset,
    signatures: [],
    customer_impact: 'Customers cannot load their profile in online and mobile banking.',
    suggested_impact: 1,
    suggested_urgency: 1,
    severity_reason: 'tier 1 apps',
    log_links: [],
    grouping: [],
  };
  c.root_cause = {
    culprit_tla: 'CIF',
    change_request: { number: 'CHG0030081', web_url: 'http://sn.test/change_requests/CHG0030081' },
    merge_request: {
      project: 'keybank/CIF00/customer-profile-api',
      iid: 9,
      title: 'Rename profile fields',
      web_url: 'http://gl.test/mr/9',
    },
    commit: null,
    files: [],
    mechanism: 'The profile API now returns snake_case fields its callers do not read.',
    evidence: [],
    ruled_out: [],
    unexplained_apps: [],
    confidence: 0.9,
  };
  c.milestones.assembled = '2026-11-11T19:16:00.000Z';
  return { deps, c };
}

function recovered(c: Case) {
  c.fix_mr = {
    project: 'keybank/CIF00/customer-profile-api',
    iid: 10,
    web_url: 'http://gl.test/mr/10',
    state: 'merged',
    source_branch: 'fix/x',
    merged_at: '2026-11-11T19:24:00.000Z',
    merge_commit_sha: 'f',
  };
  c.change = {
    number: 'CHG0030090',
    web_url: 'http://sn.test/change_requests/CHG0030090',
    state: 'closed',
    deployed_at: '2026-11-11T19:26:00.000Z',
  };
  c.verification = {
    before_per_min: 300,
    after_per_min: 1,
    healthy_since: '2026-11-11T19:28:00.000Z',
    started_at: '2026-11-11T19:26:00.000Z',
    logs_url: null,
  };
}

describe('the incident record', () => {
  it('writes the affected CIs and the outage start once, then the cause when it is known', async () => {
    const { deps, c } = world();
    c.root_cause = null;
    deps.mcp.on('update_incident', () => ({}));
    await syncIncidentRecord(deps, c);
    expect(deps.mcp.callsTo('update_incident')[0]).toEqual({
      number: 'INC0010234',
      affected_cis: ['OLB', 'MBL'],
      outage_start: onset,
    });
    await syncIncidentRecord(deps, c);
    expect(deps.mcp.callsTo('update_incident')).toHaveLength(1);

    c.root_cause = world().c.root_cause;
    await syncIncidentRecord(deps, c);
    const update = deps.mcp.callsTo('update_incident')[1]!;
    expect(update).toMatchObject({ cause_code: 'Change', caused_by_change: 'CHG0030081' });
    expect(update.outage_start).toBeUndefined();
    expect(String(update.work_note)).toContain('Cause identified');
    expect(c.milestones.cause_identified).toBeTruthy();
  });

  it('lists the configuration item first and each system once', () => {
    const { c } = world();
    expect(systemsImpacted(c)).toEqual(['CIF', 'OLB', 'MBL']);
  });
});

describe('the recorded call', () => {
  it('starts once for a P1 with recording, transcription and the Facilitator on', async () => {
    const { deps, c } = world();
    deps.mcp
      .on('start_meeting', () => ({
        meeting: { id: 'mtg_1', started_at: onset, join_url: 'http://teams.test/join' },
      }))
      .on('end_meeting', () => ({}));
    expect(await startMeeting(deps, c)).toBe(true);
    expect(deps.mcp.callsTo('start_meeting')[0]).toMatchObject({
      channel: 'ch_1',
      record: true,
      transcribe: true,
      facilitator: true,
    });
    expect(await startMeeting(deps, c)).toBe(false);
    await endMeeting(deps, c);
    await endMeeting(deps, c);
    expect(deps.mcp.callsTo('end_meeting')).toHaveLength(1);
    expect(c.meeting?.ended_at).toBeTruthy();
  });

  it('is skipped below P2, and a failure never stops the incident', async () => {
    const low = world();
    low.c.incident!.priority = 3;
    expect(await startMeeting(low.deps, low.c)).toBe(false);
    expect(low.deps.mcp.calls).toHaveLength(0);

    const broken = world();
    broken.deps.mcp.on('start_meeting', () => toolError('start_meeting', 'Teams is down'));
    expect(await startMeeting(broken.deps, broken.c)).toBe(false);
    expect(broken.c.meeting).toBeNull();
  });
});

describe('the process text', () => {
  it('writes Eastern times', () => {
    expect(et('2026-11-11T19:14:00.000Z')).toBe('2:14 PM ET');
  });

  it('without a model, an active incident gets a description and no resolution yet', async () => {
    const { deps, c } = world();
    c.root_cause = null;
    const { text, source } = await processText(deps, c, 'new');
    expect(source).toBe('deterministic');
    expect(text.description).toContain('Starting at 2:14 PM ET');
    expect(text.description).toContain('Incident Management engaged support teams at 2:16 PM ET');
    expect(text.cause).toBe('The cause is under investigation.');
    expect(text.resolution_activities).toBe('');
  });

  it('once restored it names the change, the fix and when service came back', () => {
    const { deps, c } = world();
    recovered(c);
    const text = fallbackText(deps, c, 'restored');
    expect(text.cause).toContain('CHG0030081');
    expect(text.resolution_activities).toContain('CHG0030090');
    expect(text.resolution_activities).toContain('2:28 PM ET');
    expect(resolutionFields(c, text)).toMatchObject({
      cause_code: 'Change',
      caused_by_change: 'CHG0030081',
      resolved_by_change: 'CHG0030090',
      outage_start: onset,
      service_restored_at: '2026-11-11T19:28:00.000Z',
    });
  });
});

describe('Critical Incident Communications', () => {
  it('drafts each kind once and remembers who sends it', async () => {
    const { deps, c } = world();
    recovered(c);
    deps.mcp.on('draft_incident_communication', (a) => ({
      number: a.kind === 'new' ? 'CIC0050001' : 'CIC0050002',
      web_url: `http://sn.test/communications/${a.kind}`,
      subject: `<page> ${String(a.kind).toUpperCase()} - INC0010234 - ${String(a.title)}`,
      to: 'GRP_CIM_Tech_P1',
      communication_specialist: { username: 'rsmith' },
    }));
    const active = await draftCommunication(deps, c, 'new', fallbackText(deps, c, 'new'));
    expect(active).toMatchObject({ number: 'CIC0050001', specialist: 'rsmith' });
    const first = deps.mcp.callsTo('draft_incident_communication')[0]!;
    expect(first).toMatchObject({ incident: 'INC0010234', kind: 'new', start: onset });
    expect(first.systems_impacted).toEqual(['CIF', 'OLB', 'MBL']);
    expect(first.resolved).toBeUndefined();

    await draftCommunication(deps, c, 'new', fallbackText(deps, c, 'new'));
    expect(deps.mcp.callsTo('draft_incident_communication')).toHaveLength(1);

    await draftCommunication(deps, c, 'restored', fallbackText(deps, c, 'restored'));
    const second = deps.mcp.callsTo('draft_incident_communication')[1]!;
    expect(second).toMatchObject({ kind: 'restored', resolved: '2026-11-11T19:28:00.000Z' });
    expect(String(second.resolution_activities)).toContain('CHG0030090');
    expect(c.communications.map((x) => x.kind)).toEqual(['new', 'restored']);
    // One incident, one headline: the closing text reuses the first communication's title.
    c.communications[0]!.title = 'Customer Profile Lookups Failing';
    expect((await processText(deps, c, 'restored')).text.title).toBe(
      'Customer Profile Lookups Failing',
    );
  });

  it('is not drafted for low priorities', async () => {
    const { deps, c } = world();
    c.incident!.priority = 4;
    expect(await draftCommunication(deps, c, 'new', fallbackText(deps, c, 'new'))).toBeNull();
    expect(deps.mcp.calls).toHaveLength(0);
  });
});

describe('the problem record', () => {
  it('opens one for the stand-up and renames the chat with its number', async () => {
    const { deps, c } = world();
    recovered(c);
    deps.mcp
      .on('list_problems', () => ({ items: [] }))
      .on('create_problem', () => ({
        number: 'PRB0040001',
        web_url: 'http://sn.test/problems/PRB0040001',
        standup_date: '2026-11-12',
      }))
      .on('update_channel', (a) => ({ channel: { id: 'ch_1', name: a.name } }));
    const text = fallbackText(deps, c, 'restored');
    expect(await openProblem(deps, c, text)).toBe(true);
    expect(deps.mcp.callsTo('create_problem')[0]).toMatchObject({
      incidents: ['INC0010234'],
      app_tla: 'CIF',
      cause_code: 'Change',
      caused_by_change: 'CHG0030081',
      change_request: 'CHG0030090',
      standup: true,
    });
    expect(await openProblem(deps, c, text)).toBe(false);

    expect(problemChannelName(c)).toEqual({
      name: 'inc0010234-prb0040001-customer-lookups-failing',
      display_name: 'INC0010234 · PRB0040001 Customer lookups failing',
    });
    expect(await renameForProblem(deps, c)).toBe(true);
    expect(c.channel?.name).toBe('inc0010234-prb0040001-customer-lookups-failing');
    expect(await renameForProblem(deps, c)).toBe(false);
  });

  it('adopts the problem a crashed run already opened', async () => {
    const { deps, c } = world();
    deps.mcp.on('list_problems', () => ({
      items: [{ number: 'PRB0040007', web_url: 'http://sn.test/problems/PRB0040007' }],
    }));
    expect(await openProblem(deps, c, fallbackText(deps, c, 'restored'))).toBe(true);
    expect(c.problem?.number).toBe('PRB0040007');
    expect(deps.mcp.callsTo('create_problem')).toHaveLength(0);
  });

  it('keeps long names inside the channel name limit', () => {
    const { c } = world();
    c.scope!.summary = 'Online banking, mobile banking and teller customer profile lookups failing';
    c.problem = { number: 'PRB0040001', web_url: 'x', standup_date: null };
    const name = problemChannelName(c)!.name;
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name.startsWith('inc0010234-prb0040001-')).toBe(true);
  });
});

describe('the resolution', () => {
  it('writes the Resolution section with the close notes, and says so in the channel', async () => {
    const { deps, c } = world({ AGENT_AUTO_RESOLVE: 'true' });
    recovered(c);
    c.children = ['INC0010240', 'INC0010241'];
    deps.mcp.on('update_incident', () => ({}));
    const text = fallbackText(deps, c, 'restored');
    expect(await writeResolution(deps, c, text)).toEqual({ resolved: true });
    expect(deps.mcp.callsTo('update_incident')[0]).toMatchObject({
      state: 'resolved',
      cause_code: 'Change',
      caused_by_change: 'CHG0030081',
      resolved_by_change: 'CHG0030090',
      service_restored_at: '2026-11-11T19:28:00.000Z',
    });
    c.problem = {
      number: 'PRB0040001',
      web_url: 'http://sn.test/problems/PRB0040001',
      standup_date: '2026-11-12',
    };
    c.communications = [
      {
        kind: 'restored',
        number: 'CIC0050002',
        web_url: 'http://sn.test/communications/CIC0050002',
        subject: '<page> RESTORED - INC0010234 - Customer Lookups Failing',
        title: 'Customer Lookups Failing',
        to: 'GRP_CIM_Tech_P1',
        specialist: 'rsmith',
        drafted_at: '2026-11-11T19:29:00.000Z',
      },
    ];
    c.meeting = { id: 'mtg_1', started_at: onset, ended_at: onset, join_url: '' };
    const message = T.resolutionDrafted(c, true);
    expect(message.mentions).toEqual(['rsmith']);
    expect(message.body).toMatchSnapshot();
    expect(T.communicationDrafted(c.communications[0]!).body).toMatchSnapshot();
  });
});
