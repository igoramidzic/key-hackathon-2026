/**
 * Pure scoring for the eval harness (#26). Compares what the agent did (its persisted cases plus
 * a few lookups the harness makes in the world) with the scenario's answer key and the
 * simulator's run status, and renders the markdown scorecard.
 *
 * Anything the agent hasn't done (yet) scores as not achieved: a missing incident, channel, root
 * cause or MR is a failed check, never an exception.
 */
import type { RunPhase, RunStatus, ScenarioDetail } from '@sim/contracts/simulator';
import type { Case } from '../src/cases/types';

export type Verdict = 'pass' | 'fail' | 'n/a';

export interface Check {
  verdict: Verdict;
  /** What the answer key expects. */
  want: string;
  /** What the agent did; also the table cell. */
  got: string;
}

export const CHECKS = [
  'culprit_tla',
  'culprit_change',
  'on_call',
  'callers_grouped',
  'mr_fixed',
] as const;
export type CheckName = (typeof CHECKS)[number];

export const CHECK_LABELS: Record<CheckName, string> = {
  culprit_tla: 'Culprit TLA',
  culprit_change: 'Culprit MR/CHG',
  on_call: 'On-call in channel',
  callers_grouped: 'Callers grouped',
  mr_fixed: 'MR fixed it',
};

export const TIMINGS = [
  'detected',
  'declared',
  'briefed',
  'root_cause',
  'mr_opened',
  'merged',
  'recovered',
  'resolved',
] as const;
export type TimingName = (typeof TIMINGS)[number];

/** Timings shown in the table (all of them are in the JSON and the details). */
const TABLE_TIMINGS: [TimingName, string][] = [
  ['detected', 'Detected'],
  ['briefed', 'Briefed'],
  ['root_cause', 'Root cause'],
  ['mr_opened', 'MR opened'],
  ['merged', 'Merged'],
  ['recovered', 'Recovered'],
];

/** A fix MR the harness merged, acting as the human reviewer. */
export interface HumanMerge {
  project: string;
  iid: number;
  web_url: string;
  /** When GitLab says the MR was opened. */
  opened_at: string | null;
  merged_at: string;
  merged_by: string;
  case_id: string | null;
}

/** What the harness looked up in the world after the run (null/absent = lookup failed). */
export interface Observed {
  /** Usernames in the agent's Teams channel. Falls back to the case's `members`. */
  channelMembers?: string[] | null;
  /** On-call of the culprit app's support group, from ServiceNow. */
  culpritOnCall?: { group: string; primary: string | null; secondary: string | null } | null;
  /** Child incident numbers of the agent's incident. Falls back to the case's `children`. */
  incidentChildren?: string[] | null;
  merges?: HumanMerge[];
}

export interface ScoreInput {
  scenario: ScenarioDetail;
  /** This scenario's run (null when the trigger failed). */
  run: RunStatus | null;
  /** Every case in the agent's data dir. */
  cases: Case[];
  observed?: Observed;
  /** Harness problem recorded with the score (timeout, agent crash, run stopped). */
  error?: string | null;
  artifacts?: { data_dir: string; agent_log: string } | null;
}

export interface ScenarioScore {
  scenario: string;
  title: string;
  kind: string;
  /** Every applicable check passed and the harness hit no error. */
  ok: boolean;
  passed: number;
  applicable: number;
  checks: Record<CheckName, Check>;
  /** ISO times; null when the agent (or the run) never got there. */
  timings: Record<TimingName, string | null>;
  /** What the table's offsets are measured from. */
  reference: { label: 'fault onset' | 'trigger'; at: string } | null;
  run_phase: RunPhase | null;
  case_id: string | null;
  /** Cases in the data dir, and the incidents the agent opened (more than one is noise). */
  case_count: number;
  incidents: string[];
  links: {
    incident: string | null;
    channel: string | null;
    fix_mr: string | null;
    change: string | null;
    logs: string | null;
  };
  error: string | null;
  artifacts: { data_dir: string; agent_log: string } | null;
}

export interface ScorecardMeta {
  run_id: string;
  started_at: string;
  speed: number;
  timeout_min: number;
  llm?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const eqi = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a) && Boolean(b) && a!.trim().toUpperCase() === b!.trim().toUpperCase();

const normUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** `milestones` also holds non-time bookkeeping (e.g. `members_key`): keep real times only. */
const time = (v: string | null | undefined): string | null =>
  v && !Number.isNaN(Date.parse(v)) ? v : null;

function earliest(...isos: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const t of isos) if (time(t) && (!best || ms(t) < ms(best))) best = t!;
  return best;
}

interface MrLike {
  web_url?: string | null;
  project?: string | null;
  iid?: number | null;
}

/** `<project>/-/merge_requests/<iid>` from an MR web_url. */
export function parseMrUrl(url: string): { project: string; iid: number } | null {
  const m = /^(?:[a-z]+:\/\/[^/]+)?\/*(.+?)\/-\/merge_requests\/(\d+)\b/i.exec(url.trim());
  return m ? { project: m[1]!.toLowerCase(), iid: Number(m[2]) } : null;
}

/** Same MR by URL, or by project + iid (tolerates a path prefix such as `/gitlab`). */
export function sameMr(a: MrLike, b: MrLike): boolean {
  if (a.web_url && b.web_url && normUrl(a.web_url) === normUrl(b.web_url)) return true;
  const key = (x: MrLike) =>
    x.project && x.iid
      ? { project: x.project.toLowerCase(), iid: x.iid }
      : x.web_url
        ? parseMrUrl(x.web_url)
        : null;
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb || ka.iid !== kb.iid) return false;
  return ka.project.endsWith(kb.project) || kb.project.endsWith(ka.project);
}

/** `45s`, `2m05s`, `1h03m`. */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** `+2:05` from the reference time, `—` when missing. */
export function fmtOffset(at: string | null, ref: string | null): string {
  if (!time(at)) return '—';
  if (!time(ref)) return at!.slice(11, 19);
  const sec = Math.round((ms(at) - ms(ref)) / 1000);
  const abs = Math.abs(sec);
  return `${sec < 0 ? '-' : '+'}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

/** Caller incidents a case is tied to: grouped children and the calls it was opened from. */
function caseCalls(c: Case): string[] {
  const fromSignals = c.signals.flatMap((s) => (s.source === 'human' ? [s.incident_number] : []));
  return [...new Set([...c.children, ...fromSignals])];
}

/**
 * The agent's case for this scenario: one about the scenario's apps or calls, preferably with an
 * incident and a fix MR, else the earliest. Cases merged into another one are skipped.
 */
export function pickCase(
  cases: Case[],
  run: RunStatus | null,
  scenario: ScenarioDetail,
): Case | null {
  const live = cases.filter((c) => !c.merged_into);
  const apps = new Set(
    [...(run?.affected_tlas ?? scenario.answer_key.affected_tlas), scenario.answer_key.culprit_tla]
      .filter(Boolean)
      .map((t) => t.toUpperCase()),
  );
  const calls = new Set((run?.helpdesk ?? []).map((h) => h.number));
  const relevance = (c: Case) => {
    const tlas = new Set(
      [...c.apps, c.incident?.app_tla, c.root_cause?.culprit_tla]
        .filter((t): t is string => Boolean(t))
        .map((t) => t.toUpperCase()),
    );
    let n = 0;
    for (const t of tlas) if (apps.has(t)) n++;
    for (const num of caseCalls(c)) if (calls.has(num)) n++;
    return n;
  };
  const ranked = live
    .map((c) => ({ c, r: relevance(c) }))
    .sort(
      (a, b) =>
        Number(b.r > 0) - Number(a.r > 0) ||
        Number(Boolean(b.c.incident)) - Number(Boolean(a.c.incident)) ||
        b.r - a.r ||
        Number(Boolean(b.c.fix_mr)) - Number(Boolean(a.c.fix_mr)) ||
        a.c.opened_at.localeCompare(b.c.opened_at),
    );
  return ranked[0]?.c ?? null;
}

function rootCauseAt(c: Case): string | null {
  const milestone = time(c.milestones.root_cause);
  if (milestone) return milestone;
  const event = c.timeline.find((e) => e.kind === 'decision' && e.text.startsWith('Root cause'));
  if (event) return event.at;
  return c.root_cause ? time(c.background.deep_rca?.finished_at) : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const pass = (want: string, got: string): Check => ({ verdict: 'pass', want, got });
const fail = (want: string, got: string): Check => ({ verdict: 'fail', want, got });

function checkCulpritTla(scenario: ScenarioDetail, c: Case | null): Check {
  const want = scenario.answer_key.culprit_tla;
  const named = c?.root_cause?.culprit_tla
    ? { tla: c.root_cause.culprit_tla, from: 'root cause' }
    : c?.incident?.app_tla
      ? { tla: c.incident.app_tla, from: 'incident app' }
      : null;
  if (!named) return fail(want, c ? 'none named' : 'no case');
  const got = `${named.tla} (${named.from})`;
  return eqi(named.tla, want) ? pass(want, got) : fail(want, got);
}

function checkCulpritChange(
  scenario: ScenarioDetail,
  run: RunStatus | null,
  c: Case | null,
): Check {
  const badMr = run?.bad_mr
    ? { web_url: run.bad_mr.web_url, project: scenario.bad_mr.project, iid: run.bad_mr.iid }
    : null;
  const badChg = run?.bad_change?.number ?? null;
  const want =
    [badChg, badMr ? `${badMr.project}!${badMr.iid}` : null].filter(Boolean).join(' / ') ||
    'unknown (no bad MR/CHG in the run)';
  if (!c) return fail(want, 'no case');
  // The deep root cause, else the quick pass's top suspect (what the briefing named).
  const top = c.suspects[0];
  const ref = c.root_cause
    ? { mr: c.root_cause.merge_request, chg: c.root_cause.change_request, from: 'root cause' }
    : top
      ? { mr: top.merge_request, chg: top.change_request, from: 'quick RCA' }
      : null;
  if (!ref || (!ref.mr && !ref.chg)) return fail(want, 'none named');
  const parts = [ref.chg?.number, ref.mr ? `!${ref.mr.iid}` : null].filter(Boolean);
  const got = `${parts.join(' + ')} (${ref.from})`;
  const mrHit = Boolean(ref.mr && badMr && sameMr(ref.mr, badMr));
  const chgHit = Boolean(ref.chg && eqi(ref.chg.number, badChg));
  return mrHit || chgHit ? pass(want, got) : fail(want, got);
}

function checkOnCall(c: Case | null, observed: Observed): Check {
  const oc = observed.culpritOnCall;
  const onCall = [oc?.primary, oc?.secondary].filter((u): u is string => Boolean(u));
  const want = onCall.length
    ? `${onCall.join(' or ')} (${oc!.group})`
    : 'culprit on-call (lookup failed)';
  if (!c?.channel) return fail(want, 'no channel');
  if (!onCall.length) return fail(want, 'on-call unknown');
  const members = (observed.channelMembers ?? c.members.map((m) => m.username)).map((u) =>
    u.toLowerCase(),
  );
  const present = onCall.filter((u) => members.includes(u.toLowerCase()));
  return present.length
    ? pass(want, present.join(', '))
    : fail(want, `not in channel (${members.length} members)`);
}

function checkCallers(
  scenario: ScenarioDetail,
  run: RunStatus | null,
  c: Case | null,
  observed: Observed,
): Check {
  const expected = (run?.helpdesk ?? []).map((h) => h.number);
  if (!expected.length && !scenario.helpdesk.length)
    return { verdict: 'n/a', want: 'no calls in this scenario', got: 'n/a' };
  const want = `${expected.length || scenario.helpdesk.length} call(s) under the incident`;
  // The simulator stops scheduling calls once the run recovers: a fast fix means nobody called.
  if (!expected.length && run?.phase === 'recovered')
    return { verdict: 'n/a', want, got: 'recovered before any calls came in' };
  if (!expected.length) return fail(want, 'no calls arrived');
  if (!c?.incident) return fail(want, `0/${expected.length} (no incident)`);
  const children = new Set(observed.incidentChildren ?? c.children);
  const grouped = expected.filter((n) => children.has(n));
  const got = `${grouped.length}/${expected.length}`;
  return grouped.length === expected.length ? pass(want, got) : fail(want, got);
}

function checkMrFixed(run: RunStatus | null, c: Case | null, merge: HumanMerge | null): Check {
  const want = "recovered after the agent's MR merged";
  const mr = c?.fix_mr;
  if (!mr) return fail(want, 'no fix MR');
  const mergedAt = time(merge?.merged_at) ?? time(mr.merged_at);
  if (!mergedAt) return fail(want, `!${mr.iid} not merged`);
  if (run?.phase !== 'recovered' || !time(run.recovered_at))
    return fail(want, `merged, run ${run?.phase ?? 'unknown'}`);
  // The simulator names the change it saw fix main; when that is an MR it must be the agent's.
  if (run.fix_mr && parseMrUrl(run.fix_mr.web_url) && !sameMr(run.fix_mr, mr))
    return fail(want, `recovered by ${run.fix_mr.web_url}`);
  const after = (ms(run.recovered_at) - ms(mergedAt)) / 1000;
  if (after < 0) return fail(want, 'recovered before the merge');
  const via = run.fix_change ? ` via ${run.fix_change.number}` : '';
  return pass(want, `recovered ${fmtDuration(after)} after merge${via}`);
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export function scoreScenario(input: ScoreInput): ScenarioScore {
  const { scenario, run, cases } = input;
  const observed = input.observed ?? {};
  const c = pickCase(cases, run, scenario);
  const fixMr = c?.fix_mr ?? null;
  const merge = (fixMr && (observed.merges ?? []).find((m) => sameMr(m, fixMr))) || null;

  const checks: Record<CheckName, Check> = {
    culprit_tla: checkCulpritTla(scenario, c),
    culprit_change: checkCulpritChange(scenario, run, c),
    on_call: checkOnCall(c, observed),
    callers_grouped: checkCallers(scenario, run, c, observed),
    mr_fixed: checkMrFixed(run, c, merge),
  };
  const verdicts = CHECKS.map((k) => checks[k].verdict);
  const applicable = verdicts.filter((v) => v !== 'n/a').length;
  const passed = verdicts.filter((v) => v === 'pass').length;
  const error = input.error ?? null;

  const m = c?.milestones ?? {};
  const mergedIn = c ? cases.filter((o) => o.merged_into === c.id) : [];
  const timings: Record<TimingName, string | null> = {
    detected: c
      ? earliest(
          c.opened_at,
          m.detected,
          ...mergedIn.flatMap((o) => [o.opened_at, o.milestones.detected]),
        )
      : null,
    declared: time(m.declared),
    briefed: time(m.briefed),
    root_cause: c ? rootCauseAt(c) : null,
    mr_opened: fixMr
      ? (time(merge?.opened_at) ?? time(m.awaiting_merge) ?? time(m.fix_proposed))
      : null,
    merged: fixMr ? (time(merge?.merged_at) ?? time(fixMr.merged_at)) : null,
    recovered: time(run?.recovered_at),
    resolved: c ? (time(m.resolved) ?? time(c.resolution?.resolved_at)) : null,
  };
  const reference = time(run?.fault_onset_at)
    ? { label: 'fault onset' as const, at: run!.fault_onset_at! }
    : time(run?.started_at)
      ? { label: 'trigger' as const, at: run!.started_at }
      : null;

  const incidents = [
    ...new Set(cases.filter((o) => !o.merged_into && o.incident).map((o) => o.incident!.number)),
  ];
  return {
    scenario: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    ok: !error && applicable > 0 && passed === applicable,
    passed,
    applicable,
    checks,
    timings,
    reference,
    run_phase: run?.phase ?? null,
    case_id: c?.id ?? null,
    case_count: cases.length,
    incidents,
    links: {
      incident: c?.incident?.web_url ?? null,
      channel: c?.channel?.web_url ?? null,
      fix_mr: fixMr?.web_url ?? null,
      change: c?.change?.web_url ?? null,
      logs: run?.logs_url ?? null,
    },
    error,
    artifacts: input.artifacts ?? null,
  };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

const MARK: Record<Verdict, string> = { pass: '✓', fail: '✗', 'n/a': 'n/a' };

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

const checkCell = (check: Check) =>
  check.verdict === 'n/a' ? 'n/a' : `${MARK[check.verdict]} ${check.got}`;

const link = (label: string, url: string | null) => (url ? `[${label}](${url})` : null);

/** Markdown scorecard: one table row per scenario, then the details. */
export function renderScorecard(results: ScenarioScore[], meta: ScorecardMeta): string {
  const lines: string[] = [];
  lines.push('# Incident agent eval', '');
  lines.push(
    `Run \`${meta.run_id}\` · ${meta.started_at} · speed ${meta.speed}x · timeout ${meta.timeout_min} min` +
      (meta.llm ? ` · LLM ${meta.llm}` : ''),
    '',
  );
  const head = [
    'Scenario',
    ...CHECKS.map((k) => CHECK_LABELS[k]),
    'Score',
    ...TABLE_TIMINGS.map(([, label]) => label),
  ];
  lines.push(`| ${head.join(' | ')} |`);
  lines.push(`|${head.map(() => ' --- ').join('|')}|`);
  for (const r of results) {
    const ref = r.reference?.at ?? null;
    const row = [
      `${r.ok ? '✓' : '✗'} ${r.scenario}`,
      ...CHECKS.map((k) => checkCell(r.checks[k])),
      `${r.passed}/${r.applicable}${r.error ? ' ⚠' : ''}`,
      ...TABLE_TIMINGS.map(([k]) => fmtOffset(r.timings[k], ref)),
    ];
    lines.push(`| ${row.map(cell).join(' | ')} |`);
  }
  const fully = results.filter((r) => r.ok).length;
  const passed = results.reduce((n, r) => n + r.passed, 0);
  const applicable = results.reduce((n, r) => n + r.applicable, 0);
  lines.push(
    '',
    `**${fully}/${results.length} scenarios passed**, ${passed}/${applicable} checks. ` +
      'Times are wall clock from the fault onset (from the trigger when there was none).',
  );

  for (const r of results) {
    lines.push('', `## ${r.scenario}`, '', `${r.title} (${r.kind})`, '');
    const onset = r.reference ? `, ${r.reference.label} ${r.reference.at}` : '';
    lines.push(
      `- Run: ${r.run_phase ?? 'not started'}${onset}. Case \`${r.case_id ?? 'none'}\` ` +
        `(${r.case_count} in total); incidents opened: ${r.incidents.join(', ') || 'none'}`,
    );
    const links = [
      link('incident', r.links.incident),
      link('channel', r.links.channel),
      link('fix MR', r.links.fix_mr),
      link('change', r.links.change),
      link('logs', r.links.logs),
    ].filter(Boolean);
    if (links.length) lines.push(`- Links: ${links.join(' · ')}`);
    for (const k of CHECKS) {
      const ch = r.checks[k];
      lines.push(`- ${MARK[ch.verdict]} ${CHECK_LABELS[k]}: want ${ch.want}; got ${ch.got}`);
    }
    const ref = r.reference?.at ?? null;
    const timed = TIMINGS.filter((k) => r.timings[k]).map(
      (k) => `${k.replace('_', ' ')} ${fmtOffset(r.timings[k], ref)}`,
    );
    lines.push(`- Timings: ${timed.join(', ') || 'none'}`);
    if (r.error) lines.push(`- ⚠ ${r.error}`);
    if (r.artifacts) lines.push(`- Agent log: \`${r.artifacts.agent_log}\``);
  }
  return `${lines.join('\n')}\n`;
}
