/** Eval scoring (#26) with synthetic cases, answer keys and run statuses. */
import type { RunStatus, ScenarioDetail } from '@sim/contracts/simulator';
import { describe, expect, it } from 'vitest';
import {
  fmtDuration,
  fmtOffset,
  type Observed,
  parseMrUrl,
  pickCase,
  renderScorecard,
  sameMr,
  scoreScenario,
} from '../eval/score';
import { Case, type CaseInput } from '../src/cases/types';

const GL = 'http://localhost:3003';
const SN = 'http://localhost:3002';
const PROJECT = 'keybank/CIF00/customer-profile-api';
const mrUrl = (iid: number, base = GL) => `${base}/${PROJECT}/-/merge_requests/${iid}`;
const T = (hhmmss: string) => `2026-11-11T${hhmmss}.000Z`;

function scenario(over: Partial<ScenarioDetail> = {}): ScenarioDetail {
  return {
    id: 'cif-demo-cascade',
    title: 'Demo cascade',
    kind: 'cascade',
    summary: 'synthetic',
    answer_key: {
      root_cause: 'synthetic',
      culprit_tla: 'CIF',
      affected_tlas: ['OLB', 'MBL'],
      why_it_looks_green: 'synthetic',
    },
    culprit_project: PROJECT,
    fault_onset_sec: 60,
    impacted_tlas: ['OLB', 'MBL'],
    alert_count: 0,
    helpdesk_count: 2,
    red_herring_count: 0,
    bad_mr: {
      project: PROJECT,
      title: 'Bad change',
      description: '',
      author: 'dev1',
      merged_by: 'dev2',
      source_branch: 'feature/x',
      labels: [],
      edits: [],
    },
    fix: { title: 'Fix', description: '', edits: [], files: [] },
    impacts: [],
    fanout: [],
    alerts: [],
    helpdesk: [
      { at_sec: 90, short_description: 'Lookups failing', caller: 'teller1' },
      { at_sec: 120, short_description: 'Lookups failing', caller: 'teller2' },
    ],
    red_herrings: [],
    ...over,
  };
}

function run(over: Partial<RunStatus> = {}): RunStatus {
  return {
    id: 'cif-demo-cascade',
    title: 'Demo cascade',
    kind: 'cascade',
    phase: 'recovered',
    active: false,
    speed: 4,
    started_at: T('19:00:00'),
    elapsed_sec: 480,
    fault_onset_at: T('19:01:00'),
    fixed_at: T('19:07:30'),
    recovered_at: T('19:08:00'),
    ended_at: T('19:08:00'),
    error: null,
    bad_mr: { web_url: mrUrl(12), sha: 'abc1234', short_sha: 'abc1234', iid: 12 },
    fix_mr: { web_url: mrUrl(13), sha: 'def5678' },
    bad_change: { number: 'CHG0030007', web_url: `${SN}/change_requests/CHG0030007` },
    fix_change: { number: 'CHG0030011', web_url: `${SN}/change_requests/CHG0030011` },
    fix_on_main_at: T('19:06:40'),
    helpdesk: [
      { number: 'INC0010003', web_url: `${SN}/incidents/INC0010003`, at: T('19:01:30') },
      { number: 'INC0010004', web_url: `${SN}/incidents/INC0010004`, at: T('19:02:00') },
    ],
    alerts: [],
    culprit_tla: 'CIF',
    affected_tlas: ['OLB', 'MBL'],
    logs_url: 'http://localhost:3001/logs?query=x',
    events: [],
    ...over,
  };
}

function mkCase(over: Partial<CaseInput> = {}): Case {
  return Case.parse({
    id: 'case-20261111-190145-ab121',
    kind: 'monitoring',
    phase: 'detected',
    opened_at: T('19:01:45'),
    updated_at: T('19:01:45'),
    correlation_id: 'agent-case:abc',
    apps: ['OLB', 'MBL'],
    ...over,
  });
}

/** A case where the agent did everything. */
function fullCase(over: Partial<CaseInput> = {}): Case {
  return mkCase({
    phase: 'resolved',
    updated_at: T('19:09:00'),
    incident: { number: 'INC0010005', web_url: `${SN}/incidents/INC0010005`, app_tla: 'CIF' },
    channel: { id: 'ch_1', name: 'inc0010005-lookups', web_url: 'http://localhost:3004/ch_1' },
    members: [
      { username: 'noc1', reason: 'incident commander', role: 'commander' },
      { username: 'cifoncall', reason: 'on-call for CIF', role: 'upstream' },
    ],
    root_cause: {
      culprit_tla: 'CIF',
      change_request: { number: 'CHG0030007', web_url: `${SN}/change_requests/CHG0030007` },
      merge_request: { project: PROJECT, iid: 12, title: 'Bad change', web_url: mrUrl(12) },
      commit: null,
      files: [],
      mechanism: 'synthetic',
      evidence: [],
      ruled_out: [],
      confidence: 0.9,
    },
    fix_mr: {
      project: PROJECT,
      iid: 13,
      web_url: mrUrl(13),
      state: 'merged',
      source_branch: 'fix/inc0010005-lookups',
    },
    change: { number: 'CHG0030011', web_url: `${SN}/change_requests/CHG0030011`, state: 'closed' },
    children: ['INC0010003', 'INC0010004'],
    milestones: {
      triaged: T('19:02:15'),
      declared: T('19:02:30'),
      assembled: T('19:02:50'),
      members_key: 'noc1,cifoncall', // bookkeeping, not a time
      briefed: T('19:03:05'),
      fix_proposed: T('19:05:45'),
      awaiting_merge: T('19:05:50'),
      resolved: T('19:08:40'),
    },
    timeline: [
      {
        at: T('19:04:10'),
        kind: 'decision',
        text: 'Root cause (claude, 90%, 80s): CIF CHG0030007',
      },
    ],
    ...over,
  });
}

const observedAll = (over: Partial<Observed> = {}): Observed => ({
  culpritOnCall: { group: 'CIF Support', primary: 'cifoncall', secondary: 'cifbackup' },
  channelMembers: ['noc1', 'cifoncall'],
  incidentChildren: ['INC0010003', 'INC0010004'],
  merges: [
    {
      project: PROJECT,
      iid: 13,
      web_url: mrUrl(13),
      opened_at: T('19:05:40'),
      merged_at: T('19:06:30'),
      merged_by: 'dwhitfield',
      case_id: 'case-20261111-190145-ab121',
    },
  ],
  ...over,
});

const META = {
  run_id: '20261111-185955Z',
  started_at: T('18:59:55'),
  speed: 4,
  timeout_min: 20,
  llm: 'off (heuristics)',
};

describe('scoreScenario', () => {
  it('scores a complete run 5/5 with timings from the fault onset', () => {
    const s = scoreScenario({
      scenario: scenario(),
      run: run(),
      cases: [fullCase()],
      observed: observedAll(),
    });
    expect(s.ok).toBe(true);
    expect([s.passed, s.applicable]).toEqual([5, 5]);
    expect(s.checks.culprit_tla.got).toBe('CIF (root cause)');
    expect(s.checks.culprit_change.got).toBe('CHG0030007 + !12 (root cause)');
    expect(s.checks.on_call.got).toBe('cifoncall');
    expect(s.checks.callers_grouped.got).toBe('2/2');
    expect(s.checks.mr_fixed.got).toBe('recovered 1m30s after merge via CHG0030011');
    expect(s.reference).toEqual({ label: 'fault onset', at: T('19:01:00') });
    expect(s.timings).toEqual({
      detected: T('19:01:45'),
      declared: T('19:02:30'),
      briefed: T('19:03:05'),
      root_cause: T('19:04:10'),
      mr_opened: T('19:05:40'), // GitLab's created_at beats the phase milestone
      merged: T('19:06:30'),
      recovered: T('19:08:00'),
      resolved: T('19:08:40'),
    });
    expect(s.incidents).toEqual(['INC0010005']);

    const md = renderScorecard([s], META);
    expect(md).toContain(
      '| ✓ cif-demo-cascade | ✓ CIF (root cause) | ✓ CHG0030007 + !12 (root cause) | ✓ cifoncall | ✓ 2/2 | ✓ recovered 1m30s after merge via CHG0030011 | 5/5 | +0:45 | +2:05 | +3:10 | +4:40 | +5:30 | +7:00 |',
    );
    expect(md).toContain('**1/1 scenarios passed**, 5/5 checks.');
    expect(md).toContain('- ✓ Culprit TLA: want CIF; got CIF (root cause)');
    expect(md).toContain(
      '- Timings: detected +0:45, declared +1:30, briefed +2:05, root cause +3:10, mr opened +4:40, merged +5:30, recovered +7:00, resolved +7:40',
    );
  });

  it('scores a case that only got as far as detection as not achieved, without crashing', () => {
    const s = scoreScenario({
      scenario: scenario(),
      run: run({ phase: 'degrading', recovered_at: null, fix_mr: null, fix_change: null }),
      cases: [mkCase()],
    });
    expect(s.ok).toBe(false);
    expect([s.passed, s.applicable]).toEqual([0, 5]);
    expect(s.checks.culprit_tla.got).toBe('none named');
    expect(s.checks.culprit_change.got).toBe('none named');
    expect(s.checks.on_call.got).toBe('no channel');
    expect(s.checks.callers_grouped.got).toBe('0/2 (no incident)');
    expect(s.checks.mr_fixed.got).toBe('no fix MR');
    expect(s.timings.detected).toBe(T('19:01:45'));
    expect(Object.values(s.timings).filter(Boolean)).toHaveLength(1);
    const md = renderScorecard([s], META);
    expect(md).toContain('| 0/5 | +0:45 | — | — | — | — | — |');
  });

  it('a fix that lands before the bankers call makes caller grouping n/a', () => {
    const s = scoreScenario({
      scenario: scenario(),
      run: { ...run(), helpdesk: [] },
      cases: [],
    });
    expect(s.checks.callers_grouped).toMatchObject({
      verdict: 'n/a',
      got: 'recovered before any calls came in',
    });
  });

  it('survives no cases and no run (trigger failed)', () => {
    const s = scoreScenario({
      scenario: scenario(),
      run: null,
      cases: [],
      error: 'trigger failed: 409',
    });
    expect(s.ok).toBe(false);
    expect(s.passed).toBe(0);
    expect(s.case_id).toBeNull();
    expect(s.reference).toBeNull();
    expect(s.checks.culprit_tla.got).toBe('no case');
    expect(s.checks.culprit_change.want).toBe('unknown (no bad MR/CHG in the run)');
    expect(s.checks.callers_grouped.got).toBe('no calls arrived');
    const md = renderScorecard([s], META);
    expect(md).toContain('| 0/5 ⚠ |');
    expect(md).toContain('- Run: not started.');
    expect(md).toContain('- ⚠ trigger failed: 409');
  });

  it('a perfect score with a harness error is not ok', () => {
    const s = scoreScenario({
      scenario: scenario(),
      run: run(),
      cases: [fullCase()],
      observed: observedAll(),
      error: 'agent exited (code 1)',
    });
    expect([s.passed, s.applicable, s.ok]).toEqual([5, 5, false]);
  });
});

describe('checks', () => {
  const score = (c: Case, obs: Partial<Observed> = {}, r: Partial<RunStatus> = {}) =>
    scoreScenario({ scenario: scenario(), run: run(r), cases: [c], observed: observedAll(obs) })
      .checks;

  it('culprit TLA: root cause, else the incident app; a wrong one fails', () => {
    expect(score(fullCase({ root_cause: null })).culprit_tla).toMatchObject({
      verdict: 'pass',
      got: 'CIF (incident app)',
    });
    const wrong = fullCase();
    wrong.root_cause!.culprit_tla = 'ATH';
    expect(score(wrong).culprit_tla).toMatchObject({ verdict: 'fail', got: 'ATH (root cause)' });
  });

  it('culprit MR/CHG: the CHG alone, the MR behind a path prefix, or the quick RCA suspect', () => {
    const chgOnly = fullCase();
    chgOnly.root_cause!.merge_request = null;
    expect(score(chgOnly).culprit_change).toMatchObject({
      verdict: 'pass',
      got: 'CHG0030007 (root cause)',
    });

    const mrOnly = fullCase();
    mrOnly.root_cause!.change_request = null;
    mrOnly.root_cause!.merge_request!.web_url = mrUrl(12, 'https://sim.example/gitlab');
    expect(score(mrOnly).culprit_change.verdict).toBe('pass');

    const other = fullCase();
    other.root_cause!.change_request!.number = 'CHG0030009';
    other.root_cause!.merge_request!.iid = 7;
    other.root_cause!.merge_request!.web_url = mrUrl(7);
    expect(score(other).culprit_change).toMatchObject({
      verdict: 'fail',
      got: 'CHG0030009 + !7 (root cause)',
    });

    const quick = fullCase({
      root_cause: null,
      suspects: [
        {
          tla: 'CIF',
          change_request: { number: 'CHG0030007', web_url: '' },
          merge_request: null,
          promoted_at: null,
          author: null,
          reason: 'promoted just before the onset',
          confidence: 0.7,
        },
      ],
    });
    expect(score(quick).culprit_change).toMatchObject({
      verdict: 'pass',
      got: 'CHG0030007 (quick RCA)',
    });
  });

  it("on-call: primary or secondary in the channel; falls back to the case's members", () => {
    expect(score(fullCase(), { channelMembers: ['noc1', 'CIFBACKUP'] }).on_call).toMatchObject({
      verdict: 'pass',
      got: 'cifbackup',
    });
    expect(score(fullCase(), { channelMembers: null }).on_call.verdict).toBe('pass');
    expect(score(fullCase(), { channelMembers: ['noc1'] }).on_call).toMatchObject({
      verdict: 'fail',
      got: 'not in channel (1 members)',
    });
    expect(score(fullCase(), { culpritOnCall: null }).on_call).toMatchObject({
      verdict: 'fail',
      got: 'on-call unknown',
    });
  });

  it("callers: n/a without calls; partial fails; the incident's live children win", () => {
    const none = scoreScenario({
      scenario: scenario({ helpdesk: [] }),
      run: run({ helpdesk: [] }),
      cases: [fullCase()],
      observed: observedAll(),
    });
    expect(none.checks.callers_grouped.verdict).toBe('n/a');
    expect([none.passed, none.applicable, none.ok]).toEqual([4, 4, true]);
    expect(renderScorecard([none], META)).toContain('| n/a |');

    expect(score(fullCase(), { incidentChildren: ['INC0010004'] }).callers_grouped).toMatchObject({
      verdict: 'fail',
      got: '1/2',
    });
    expect(score(fullCase({ children: [] }), { incidentChildren: null }).callers_grouped.got).toBe(
      '0/2',
    );
  });

  it('MR fixed it: needs a merged agent MR and recovery after it', () => {
    expect(score(fullCase({ fix_mr: null })).mr_fixed.got).toBe('no fix MR');
    expect(score(fullCase(), { merges: [] }).mr_fixed).toMatchObject({
      verdict: 'fail',
      got: '!13 not merged',
    });
    const mergedByAgentRecord = fullCase();
    mergedByAgentRecord.fix_mr!.merged_at = T('19:06:35');
    expect(score(mergedByAgentRecord, { merges: [] }).mr_fixed.verdict).toBe('pass');
    expect(score(fullCase(), {}, { phase: 'degrading', recovered_at: null }).mr_fixed.got).toBe(
      'merged, run degrading',
    );
    expect(score(fullCase(), {}, { fix_mr: { web_url: mrUrl(99), sha: 'x' } }).mr_fixed.got).toBe(
      `recovered by ${mrUrl(99)}`,
    );
    // The simulator may name a commit instead of an MR: that does not count against the agent.
    const commit = `${GL}/${PROJECT}/-/commit/def5678`;
    expect(score(fullCase(), {}, { fix_mr: { web_url: commit, sha: 'x' } }).mr_fixed.verdict).toBe(
      'pass',
    );
    expect(score(fullCase(), {}, { recovered_at: T('19:06:00') }).mr_fixed.got).toBe(
      'recovered before the merge',
    );
  });
});

describe('pickCase', () => {
  it("prefers the scenario's case over noise, skips merged cases, and counts their detection", () => {
    const noise = mkCase({
      id: 'case-noise',
      opened_at: T('19:00:10'),
      apps: ['PAY'],
      incident: { number: 'INC0010002', web_url: '', app_tla: 'PAY' },
    });
    const merged = mkCase({ id: 'case-early', opened_at: T('19:01:20'), merged_into: 'case-main' });
    const main = fullCase({ id: 'case-main' });
    const cases = [noise, merged, main];
    expect(pickCase(cases, run(), scenario())?.id).toBe('case-main');

    const s = scoreScenario({ scenario: scenario(), run: run(), cases, observed: observedAll() });
    expect(s.case_id).toBe('case-main');
    expect(s.timings.detected).toBe(T('19:01:20'));
    expect(s.incidents).toEqual(['INC0010002', 'INC0010005']);
    expect(s.case_count).toBe(3);
  });

  it('finds a human-reported case through the calls it was opened from', () => {
    const human = mkCase({
      id: 'case-calls',
      kind: 'human-reported',
      apps: [],
      signals: [
        {
          source: 'human',
          id: 'h1',
          at: T('19:01:30'),
          incident_number: 'INC0010003',
          short_description: 'Lookups failing',
          description: '',
          caller: 'teller1',
          contact_type: 'phone',
          web_url: '',
        },
      ],
    });
    const noise = mkCase({ id: 'case-noise', apps: ['PAY'] });
    expect(pickCase([noise, human], run(), scenario())?.id).toBe('case-calls');
    expect(pickCase([], run(), scenario())).toBeNull();
  });
});

describe('helpers', () => {
  it('matches MRs by URL or by project and iid', () => {
    expect(parseMrUrl(mrUrl(12))).toEqual({ project: PROJECT.toLowerCase(), iid: 12 });
    expect(parseMrUrl(`${GL}/${PROJECT}/-/commit/abc`)).toBeNull();
    expect(sameMr({ web_url: `${mrUrl(12)}/` }, { web_url: mrUrl(12) })).toBe(true);
    expect(sameMr({ project: PROJECT, iid: 12 }, { web_url: mrUrl(12, 'https://x/gitlab') })).toBe(
      true,
    );
    expect(sameMr({ project: PROJECT, iid: 12 }, { project: PROJECT, iid: 13 })).toBe(false);
    expect(sameMr({ project: 'keybank/PAY00/payments-api', iid: 12 }, { web_url: mrUrl(12) })).toBe(
      false,
    );
  });

  it('formats offsets and durations', () => {
    expect(fmtOffset(T('19:03:05'), T('19:01:00'))).toBe('+2:05');
    expect(fmtOffset(T('19:00:50'), T('19:01:00'))).toBe('-0:10');
    expect(fmtOffset(null, T('19:01:00'))).toBe('—');
    expect(fmtOffset('not a time', T('19:01:00'))).toBe('—');
    expect(fmtOffset(T('19:03:05'), null)).toBe('19:03:05');
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(125)).toBe('2m05s');
    expect(fmtDuration(3780)).toBe('1h03m');
  });

  it('escapes pipes in table cells', () => {
    const c = fullCase();
    c.root_cause!.culprit_tla = 'A|B';
    const s = scoreScenario({
      scenario: scenario(),
      run: run(),
      cases: [c],
      observed: observedAll(),
    });
    expect(renderScorecard([s], META)).toContain('✗ A\\|B (root cause)');
  });
});
