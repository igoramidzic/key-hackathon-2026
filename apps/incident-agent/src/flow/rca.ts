/**
 * Root cause (#17): which ServiceNow change / GitLab MR broke production.
 *
 * Quick pass (gates the briefing): every change KBR promoted to production for the upstream
 * candidates and the busiest affected apps in the 6h before onset, ranked by
 *   coverage   how many failing apps depend on (or are) the changed app — the culprit of a
 *              cascade looks healthy, so walk upstream;
 *   position   its rank among the case's upstream candidates;
 *   timing     promoted shortly before the errors started (merged ≠ deployed: only promoted
 *              changes count);
 *   relevance  the diff touches what the errors talk about.
 * Deep pass (background): reads the diffs, checks the culprit explains every app, cites evidence
 * with the links the tools returned and rules out the red herrings. With Claude enabled an LLM
 * phase does the deep pass on top of the deterministic draft; its references are verified.
 *
 * Prompts and scoring are generic: no TLA, MR title or fix is known in advance.
 */

import { z } from 'zod';
import type { Case, LogSignal, MrRef, RootCause, Suspect } from '../cases/types';
import { RootCause as RootCauseSchema, Suspect as SuspectSchema } from '../cases/types';
import type { DependencyGraph } from '../correlate/graph';
import { duration, errorMessage, hhmm, uniq } from '../util';
import type { FlowDeps } from './steps';

export interface ChangeSummary {
  number: string;
  state: string;
  type?: string;
  short_description: string;
  app_tla: string;
  projects?: string[];
  implemented_at: string | null;
  requested_by?: { username: string; name?: string };
  web_url: string;
}

export interface ChangeDetail extends ChangeSummary {
  merge_requests: {
    reference: string;
    title: string | null;
    state: string | null;
    merge_commit_sha: string | null;
    web_url: string;
  }[];
  deployments?: { project: string; sha: string; deployed_at: string; tag: string | null }[];
}

export interface MrDetail {
  project: string;
  iid: number;
  title: string;
  description?: string;
  state: string;
  author: string | { username: string };
  merged_at: string | null;
  merged_by?: string | { username: string } | null;
  approved_by?: (string | { username: string })[];
  merge_commit_sha: string | null;
  source_branch?: string;
  labels?: string[];
  web_url: string;
  changes?: { path: string; diff: string; new_file?: boolean; deleted_file?: boolean }[];
  notes?: { author: string | { username: string }; body: string }[];
}

export const username = (u: string | { username: string } | null | undefined): string | null =>
  !u ? null : typeof u === 'string' ? u : u.username;

/** `keybank/CIF00/customer-profile-api!42` → { project, iid } */
export function parseMrReference(ref: string): { project: string; iid: number } | null {
  const m = ref.match(/^(.+)!(\d+)$/);
  return m ? { project: m[1]!, iid: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// Relevance: does the diff touch what the errors talk about?
// ---------------------------------------------------------------------------

const STOP = new Set(
  `about after again against also because been before being between both cannot could does doing during each from further have having here into itself just more most need only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your error errors exception failed failure request response value values data null true false return public private class const string import export default function void static final void main test tests java spring http https json yaml version service services server client info warn debug level message messages type types code line file files path true false undefined object number boolean list items item config configuration application changelog readme added updated update updates change changes`.split(
    /\s+/,
  ),
);

/** Identifier-ish tokens, split on camelCase / snake_case / kebab-case, lower-cased. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map((p) => p.toLowerCase());
    const whole = word.toLowerCase().replace(/[_-]/g, '');
    for (const p of [...parts, whole]) if (p.length >= 4 && !STOP.has(p)) out.add(p);
  }
  return out;
}

/** Only the changed lines and paths of a unified diff. */
export function changedText(mr: Pick<MrDetail, 'title' | 'description' | 'changes'>): string {
  const lines: string[] = [mr.title, mr.description ?? ''];
  for (const ch of mr.changes ?? []) {
    lines.push(ch.path);
    for (const l of ch.diff.split('\n')) if (/^[+-](?![+-])/.test(l)) lines.push(l.slice(1));
  }
  return lines.join('\n');
}

export function errorText(c: Case): string {
  const parts: string[] = [];
  for (const s of c.scope?.signatures ?? []) parts.push(s.error_type, s.message, s.stack_excerpt);
  for (const s of c.signals)
    if (s.source === 'logs') parts.push(...s.sample_messages, ...s.error_types);
  for (const s of c.signals)
    if (s.source === 'human') parts.push(s.short_description, s.description);
  return parts.join('\n');
}

export function relevance(diffText: string, errors: string): { score: number; overlap: string[] } {
  const a = tokens(diffText);
  const overlap = [...tokens(errors)].filter((t) => a.has(t));
  return { score: Math.min(1, overlap.length / 4), overlap: overlap.slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Quick pass
// ---------------------------------------------------------------------------

export interface ScoredChange {
  change: ChangeSummary;
  tla: string;
  coverage: number;
  explains: string[];
  unexplained: string[];
  position: number;
  timing: number;
  gapMs: number;
  relevance: number;
  overlap: string[];
  mrs: MrDetail[];
  score: number;
}

/** Failing apps of the case (those with errors, or every app for human-reported cases). */
export function failingApps(c: Case): string[] {
  const withErrors = (c.scope?.affected_apps ?? [])
    .filter((a) => a.error_count > 0)
    .map((a) => a.tla);
  return withErrors.length ? withErrors : c.apps;
}

export function candidateApps(c: Case, graph: DependencyGraph, limit = 14): string[] {
  const busiest = [...(c.scope?.affected_apps ?? [])]
    .sort((a, b) => b.error_count - a.error_count)
    .map((a) => a.tla);
  const upstream1 = busiest.slice(0, 3).flatMap((t) => [...(graph.up.get(t) ?? [])]);
  return uniq([
    ...c.upstream_candidates.slice(0, 6).map((u) => u.tla),
    ...busiest.slice(0, 5),
    ...c.apps.slice(0, 5),
    ...upstream1,
  ]).slice(0, limit);
}

function scoreChange(
  c: Case,
  graph: DependencyGraph,
  change: ChangeSummary,
  onset: number,
): Omit<ScoredChange, 'mrs' | 'relevance' | 'overlap'> {
  const failing = failingApps(c);
  const tla = change.app_tla;
  const explains = failing.filter((a) => a === tla || graph.upstreamOf(a, 3).has(tla));
  const coverage = failing.length ? explains.length / failing.length : 0;
  const idx = c.upstream_candidates.findIndex((u) => u.tla === tla);
  const position = idx === -1 ? (c.apps.includes(tla) ? 0.5 : 0.3) : Math.max(0.3, 1 - idx * 0.15);
  const at = change.implemented_at ? Date.parse(change.implemented_at) : Number.NaN;
  const gapMs = onset - at;
  const timing =
    !Number.isFinite(at) || gapMs < -120_000 ? 0 : Math.exp(-Math.max(0, gapMs) / (45 * 60_000));
  return {
    change,
    tla,
    coverage,
    explains,
    unexplained: failing.filter((a) => !explains.includes(a)),
    position,
    timing,
    gapMs,
    score: 0.4 * coverage + 0.2 * timing + 0.15 * position,
  };
}

async function loadMrs(deps: FlowDeps, c: Case, change: ChangeSummary): Promise<MrDetail[]> {
  const detail = await deps.mcp.call<ChangeDetail>(
    'get_change_request',
    { number: change.number },
    { caseId: c.id },
  );
  const out: MrDetail[] = [];
  for (const mr of detail.merge_requests ?? []) {
    const ref = parseMrReference(mr.reference);
    if (!ref) continue;
    try {
      out.push(await deps.mcp.call<MrDetail>('get_merge_request', ref, { caseId: c.id }));
    } catch (err) {
      deps.log.debug(`get_merge_request ${mr.reference}: ${errorMessage(err)}`);
    }
  }
  return out;
}

/** Ranked promoted changes around the onset. */
export async function rankChanges(deps: FlowDeps, c: Case, withDiffs = 5): Promise<ScoredChange[]> {
  const graph = deps.graph();
  const onset = Date.parse(c.scope?.onset ?? c.onset_at ?? c.opened_at);
  const after = new Date(onset - 6 * 3600_000).toISOString();
  const seen = new Set<string>();
  const scored: Omit<ScoredChange, 'mrs' | 'relevance' | 'overlap'>[] = [];
  for (const tla of candidateApps(c, graph)) {
    const res = await deps.mcp.call<{ items: ChangeSummary[] }>(
      'list_change_requests',
      { app_tla: tla, implemented_after: after, limit: 20 },
      { caseId: c.id },
    );
    for (const ch of res.items ?? []) {
      if (seen.has(ch.number) || !ch.implemented_at) continue;
      seen.add(ch.number);
      scored.push(scoreChange(c, graph, ch, onset));
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const errors = errorText(c);
  const out: ScoredChange[] = [];
  for (const [i, s] of scored.entries()) {
    const mrs = i < withDiffs ? await loadMrs(deps, c, s.change) : [];
    const rel = relevance(mrs.map(changedText).join('\n') || s.change.short_description, errors);
    out.push({
      ...s,
      mrs,
      relevance: rel.score,
      overlap: rel.overlap,
      score: s.score + 0.25 * rel.score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function mrRef(mr: MrDetail | undefined): MrRef | null {
  return mr ? { project: mr.project, iid: mr.iid, title: mr.title, web_url: mr.web_url } : null;
}

function why(s: ScoredChange, failingCount: number): string {
  const parts = [
    `${s.change.number} promoted ${s.tla} ${s.gapMs >= 0 ? `${duration(s.gapMs)} before the errors started` : `${duration(-s.gapMs)} after onset`}`,
    s.coverage === 1
      ? failingCount > 1
        ? `every failing app depends on ${s.tla}`
        : `${s.tla} is the failing app`
      : `${s.explains.length}/${failingCount} failing apps depend on ${s.tla}`,
  ];
  if (s.overlap.length)
    parts.push(`the change touches ${s.overlap.slice(0, 4).join(', ')} like the errors`);
  return parts.join('; ');
}

export async function quickRca(deps: FlowDeps, c: Case): Promise<Suspect[]> {
  const ranked = await rankChanges(deps, c, 4);
  const failing = failingApps(c).length;
  return ranked.slice(0, 3).map((s) => ({
    tla: s.tla,
    change_request: { number: s.change.number, web_url: s.change.web_url },
    merge_request: mrRef(s.mrs[0]),
    promoted_at: s.change.implemented_at,
    author: username(s.mrs[0]?.author) ?? s.change.requested_by?.username ?? null,
    reason: why(s, failing),
    confidence: Math.round(Math.min(0.95, s.score) * 100) / 100,
  }));
}

const QUICK_TOOLS = [
  'list_change_requests',
  'get_change_request',
  'list_merge_requests',
  'get_merge_request',
  'get_app',
  'get_app_dependencies',
  'summarize_errors',
  'search_logs',
];

const QUICK_SYSTEM = `You are the quick root-cause pass of a bank's incident-response agent. You are
read-only: investigate with the tools and answer with JSON, fast (under two minutes). Name up to
three production changes that most likely caused the errors, best first. Rules:
- Merged is not deployed: only changes KBR promoted through a change request reached production.
  Use list_change_requests (app_tla, implemented_after) for the failing apps and their upstreams.
- The culprit of a cascade often looks healthy: it returns 200s and only downstream apps error.
  Walk upstream from the failing apps; an app every failing app depends on is the first suspect.
- Unrelated changes land at the same time on purpose: prefer the change whose diff touches what
  the errors talk about.
- Copy change_request and merge_request references exactly from tool results.`;

const QuickSchema = z.object({ suspects: z.array(SuspectSchema).max(3) });

/** Checks a suspect's change and MR exist and takes their links and times from the tools. */
async function verifySuspect(deps: FlowDeps, c: Case, s: Suspect): Promise<Suspect | null> {
  try {
    let promoted_at = s.promoted_at;
    let change_request = s.change_request;
    let merge_request = s.merge_request;
    let author = s.author;
    if (change_request) {
      const ch = await deps.mcp.call<ChangeDetail>(
        'get_change_request',
        { number: change_request.number },
        { caseId: c.id },
      );
      change_request = { number: ch.number, web_url: ch.web_url };
      promoted_at = ch.implemented_at ?? promoted_at;
      if (!merge_request && ch.merge_requests?.[0]) {
        const ref = parseMrReference(ch.merge_requests[0].reference);
        if (ref)
          merge_request = {
            ...ref,
            title: ch.merge_requests[0].title ?? '',
            web_url: ch.merge_requests[0].web_url,
          };
      }
    }
    if (merge_request) {
      const mr = await deps.mcp.call<MrDetail>(
        'get_merge_request',
        { project: merge_request.project, iid: merge_request.iid },
        { caseId: c.id },
      );
      merge_request = mrRef(mr);
      author = username(mr.author) ?? author;
    }
    if (!change_request && !merge_request) return null;
    return { ...s, change_request, merge_request, promoted_at, author };
  } catch (err) {
    deps.log.debug(
      `suspect ${s.tla} ${s.change_request?.number ?? ''} dropped: ${errorMessage(err)}`,
    );
    return null;
  }
}

/** Quick pass: the AI by default, the deterministic ranking with AGENT_LLM=off or as a fallback. */
export async function quickRcaPhase(
  deps: FlowDeps,
  c: Case,
): Promise<{ suspects: Suspect[]; source: 'llm' | 'heuristic' }> {
  if (!deps.runner) return { suspects: await quickRca(deps, c), source: 'heuristic' };
  const failing = failingApps(c);
  const out = await deps.runner.run({
    name: 'quick_rca',
    caseId: c.id,
    system: QUICK_SYSTEM,
    prompt: [
      `Case ${c.id}: ${c.scope?.summary ?? ''}. Errors started ${c.scope?.onset ?? c.onset_at}.`,
      `Failing apps (${failing.length}): ${failing.join(', ')}.`,
      `Apps every failing app depends on (from the CMDB): ${c.upstream_candidates.map((u) => `${u.tla} (${u.covers}/${u.of}${u.failing ? ', failing' : ', no errors'})`).join(', ') || 'none'}.`,
      `Error signatures:\n${(c.scope?.signatures ?? []).map((s) => `- ${s.app_tla} ${s.error_type}: ${s.message}`).join('\n')}`,
      'Return {"suspects": [...]} with up to three Suspect objects, best first, each with a reason and a confidence between 0 and 1.',
    ].join('\n\n'),
    tools: QUICK_TOOLS,
    schema: QuickSchema,
    maxTurns: 16,
    timeoutMs: 120_000,
  });
  if (!out.ok) {
    deps.store.event(
      c,
      'llm',
      `AI quick RCA failed (${out.error}); falling back to the deterministic ranking`,
    );
    return { suspects: await quickRca(deps, c), source: 'heuristic' };
  }
  deps.store.event(
    c,
    'llm',
    `AI quick RCA: ${out.usage.turns} turns, $${out.usage.costUsd.toFixed(3)}`,
  );
  const verified: Suspect[] = [];
  for (const s of out.value.suspects) {
    const v = await verifySuspect(deps, c, s);
    if (v) verified.push(v);
  }
  if (!verified.length) {
    deps.store.event(
      c,
      'llm',
      'AI quick RCA named no change that exists; falling back to the deterministic ranking',
    );
    return { suspects: await quickRca(deps, c), source: 'heuristic' };
  }
  return { suspects: verified, source: 'llm' };
}

// ---------------------------------------------------------------------------
// Deep pass
// ---------------------------------------------------------------------------

function firstChangedLines(mr: MrDetail, max = 4): string[] {
  const out: string[] = [];
  for (const ch of mr.changes ?? []) {
    for (const l of ch.diff.split('\n')) {
      if (/^[+-](?![+-])/.test(l) && l.slice(1).trim()) out.push(`${ch.path}: ${l.trim()}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Deterministic deep pass: reads diffs, checks coverage, cites evidence, rules out the rest. */
export async function heuristicDeepRca(deps: FlowDeps, c: Case): Promise<RootCause | null> {
  const ranked = await rankChanges(deps, c, 6);
  const top = ranked[0];
  if (!top) return null;
  const graph = deps.graph();
  const failing = failingApps(c);
  const mr = top.mrs[0];
  let commit: RootCause['commit'] = null;
  if (mr?.merge_commit_sha) {
    try {
      const cm = await deps.mcp.call<{ id?: string; sha?: string; web_url: string }>(
        'get_commit',
        { project: mr.project, sha: mr.merge_commit_sha },
        { caseId: c.id },
      );
      commit = { sha: mr.merge_commit_sha, web_url: cm.web_url };
    } catch {
      // the MR link is enough
    }
  }
  const lines = mr ? firstChangedLines(mr) : [];
  const evidence: RootCause['evidence'] = [
    {
      claim: `${top.change.number} (${top.change.short_description}) put ${top.tla} into production at ${hhmm(top.change.implemented_at)}, ${top.gapMs >= 0 ? `${duration(top.gapMs)} before the first errors` : 'around the onset'}`,
      web_url: top.change.web_url,
    },
  ];
  if (mr)
    evidence.push({
      claim: `${mr.project}!${mr.iid} "${mr.title}" by ${username(mr.author)} changed ${(mr.changes ?? []).map((ch) => ch.path).join(', ')}${lines.length ? `: ${lines.slice(0, 2).join(' | ')}` : ''}`,
      web_url: mr.web_url,
    });
  const appUrl = graph.nodes.get(top.tla)?.web_url;
  if (appUrl && failing.length > 1)
    evidence.push({
      claim: `${top.explains.length} of ${failing.length} failing apps depend on ${top.tla}${c.upstream_candidates.find((u) => u.tla === top.tla && !u.failing) ? `, which itself logs no errors` : ''}`,
      web_url: appUrl,
    });
  const link = c.scope?.log_links[0];
  if (link && top.overlap.length)
    evidence.push({
      claim: `the errors mention ${top.overlap.slice(0, 4).join(', ')}, which the change touches`,
      web_url: link.logs_url,
    });
  if (commit)
    evidence.push({
      claim: `merge commit ${commit.sha.slice(0, 8)} is the deployed version`,
      web_url: commit.web_url,
    });

  const ruled_out: RootCause['ruled_out'] = ranked.slice(1, 6).map((s) => {
    const reasons: string[] = [];
    if (s.coverage < 1)
      reasons.push(
        `doesn't explain ${s.unexplained.slice(0, 4).join(', ')}${s.unexplained.length > 4 ? ` and ${s.unexplained.length - 4} more` : ''} (they don't depend on ${s.tla})`,
      );
    if (s.gapMs < 0) reasons.push('promoted after the errors started');
    if (s.mrs.length && s.relevance === 0)
      reasons.push('the diff has nothing to do with the errors');
    if (!reasons.length)
      reasons.push(
        `weaker match than ${top.change.number} (${Math.round(s.score * 100)} vs ${Math.round(top.score * 100)})`,
      );
    return {
      ref: `${s.change.number} ${s.tla}: ${s.change.short_description}`,
      reason: reasons.join('; '),
    };
  });

  // Merged to main but never promoted: QV only, can't be the cause.
  try {
    const onset = Date.parse(c.scope?.onset ?? c.onset_at ?? c.opened_at);
    const merged = await deps.mcp.call<{ items: MrDetail[] }>(
      'list_merge_requests',
      {
        tla: top.tla,
        state: 'merged',
        merged_after: new Date(onset - 6 * 3600_000).toISOString(),
        limit: 20,
      },
      { caseId: c.id },
    );
    const promoted = new Set(ranked.flatMap((s) => s.mrs.map((m) => `${m.project}!${m.iid}`)));
    const changeMrs = await deps.mcp
      .call<{ items: ChangeSummary[] }>(
        'list_change_requests',
        { app_tla: top.tla, limit: 50 },
        { caseId: c.id },
      )
      .catch(() => ({ items: [] }));
    for (const m of merged.items ?? []) {
      const key = `${m.project}!${m.iid}`;
      if (promoted.has(key) || (mr && key === `${mr.project}!${mr.iid}`)) continue;
      const inChange = (changeMrs.items ?? []).some((ch) => ch.short_description.includes(m.title));
      if (!inChange)
        ruled_out.push({
          ref: `${key} ${m.title}`,
          reason: 'merged to main (QV) but never promoted to production',
        });
    }
  } catch {
    // optional
  }

  const unexplained = top.unexplained.map((tla) => ({
    tla,
    reason: `${tla} does not depend on ${top.tla}`,
  }));
  const mechanism = mr
    ? `${mr.title}${lines.length ? ` (${lines.slice(0, 3).join('; ')})` : ''}. ${top.coverage === 1 && failing.length > 1 ? `Every failing app calls ${top.tla} directly or through another app, so the change reaches all of them${c.upstream_candidates.find((u) => u.tla === top.tla && !u.failing) ? ` while ${top.tla} itself keeps returning 200s` : ''}.` : ''}`
    : `${top.change.short_description} promoted ${top.tla} shortly before the errors began.`;
  const confidence = Math.min(
    0.95,
    top.score + (unexplained.length === 0 ? 0.05 : -0.1) + (top.relevance > 0 ? 0.05 : 0),
  );
  return {
    culprit_tla: top.tla,
    change_request: { number: top.change.number, web_url: top.change.web_url },
    merge_request: mrRef(mr),
    commit,
    files: (mr?.changes ?? []).map((ch) => ch.path),
    mechanism: mechanism.trim(),
    evidence,
    ruled_out,
    unexplained_apps: unexplained,
    confidence: Math.round(confidence * 100) / 100,
  };
}

const DEEP_TOOLS = [
  'list_change_requests',
  'get_change_request',
  'list_merge_requests',
  'get_merge_request',
  'list_recent_commits',
  'get_commit',
  'compare_refs',
  'get_file',
  'get_file_tree',
  'fetch_repository',
  'get_project',
  'get_app',
  'get_app_dependencies',
  'search_logs',
  'get_log_entry',
  'summarize_errors',
];

const DEEP_SYSTEM = `You are the root-cause investigator of a bank's incident-response agent. You are
read-only: investigate with the tools and answer with JSON. Find the production change (ServiceNow
change request and GitLab merge request) that caused the errors, and prove the mechanism from the
code. Rules:
- Merged is not deployed. Only changes KBR promoted through a closed change request reached
  production (kbr-<CHG> tags, KBR notes on the MR).
- The culprit of a cascade often looks healthy: it returns 200s and only downstream apps error.
  Walk upstream from the failing apps.
- Unrelated changes land at the same time on purpose. Rule them out explicitly with a reason.
- The root cause must explain every failing app; list the ones it doesn't in unexplained_apps.
- Every evidence item needs a web_url copied from a tool result. Never construct URLs.`;

function referencesAreReal(deps: FlowDeps, rc: RootCause): string | null {
  const bases = Object.values(deps.config.web);
  for (const e of rc.evidence)
    if (!bases.some((b) => e.web_url.startsWith(b)))
      return `evidence link ${e.web_url} is not a link into the world`;
  return null;
}

/** Deep pass: the AI by default (references verified); deterministic with AGENT_LLM=off or as a fallback. */
export async function deepRca(
  deps: FlowDeps,
  c: Case,
  hint?: string,
): Promise<{ rootCause: RootCause | null; source: 'llm' | 'heuristic' }> {
  if (!deps.runner) return { rootCause: await heuristicDeepRca(deps, c), source: 'heuristic' };
  const failing = failingApps(c);
  const prompt = [
    `Case ${c.id}: ${c.scope?.summary ?? ''}. Errors started ${c.scope?.onset ?? c.onset_at}.`,
    `Failing apps (${failing.length}): ${failing.join(', ')}.`,
    `Apps every failing app depends on (from the CMDB): ${c.upstream_candidates.map((u) => `${u.tla} (${u.covers}/${u.of}${u.failing ? ', failing' : ', no errors'})`).join(', ') || 'none'}.`,
    `Error signatures:\n${(c.scope?.signatures ?? []).map((s) => `- ${s.app_tla} ${s.error_type}: ${s.message}`).join('\n')}`,
    c.suspects.length
      ? `Quick-pass suspects (unconfirmed):\n${c.suspects.map((s) => `- ${s.tla} ${s.change_request?.number ?? ''} ${s.merge_request?.web_url ?? ''}: ${s.reason}`).join('\n')}`
      : '',
    hint ? `A human in the incident channel says: "${hint}". Take it seriously and check it.` : '',
    'Confirm or correct the cause by reading the change requests, the merge request diffs and the code. Return RootCause JSON.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const out = await deps.runner.run({
    name: 'rca',
    caseId: c.id,
    system: DEEP_SYSTEM,
    prompt,
    tools: DEEP_TOOLS,
    schema: RootCauseSchema,
    model: deps.runner.models.deep,
    maxTurns: 30,
    timeoutMs: 6 * 60_000,
  });
  if (!out.ok) {
    deps.store.event(
      c,
      'llm',
      `AI deep RCA failed (${out.error}); falling back to the deterministic analysis`,
    );
    return { rootCause: await heuristicDeepRca(deps, c), source: 'heuristic' };
  }
  const rc = out.value;
  // Verify the change and MR exist and take their links from the tools, not the model.
  try {
    if (rc.change_request) {
      const ch = await deps.mcp.call<ChangeDetail>(
        'get_change_request',
        { number: rc.change_request.number },
        { caseId: c.id },
      );
      rc.change_request.web_url = ch.web_url;
    }
    if (rc.merge_request) {
      const mr = await deps.mcp.call<MrDetail>(
        'get_merge_request',
        { project: rc.merge_request.project, iid: rc.merge_request.iid },
        { caseId: c.id },
      );
      rc.merge_request = mrRef(mr);
    }
  } catch (err) {
    deps.store.event(
      c,
      'llm',
      `AI deep RCA named records that don't exist (${errorMessage(err)}); falling back to the deterministic analysis`,
    );
    return { rootCause: await heuristicDeepRca(deps, c), source: 'heuristic' };
  }
  if (!deps.graph().nodes.has(rc.culprit_tla)) {
    deps.store.event(
      c,
      'llm',
      `AI deep RCA named an unknown app ${rc.culprit_tla}; falling back to the deterministic analysis`,
    );
    return { rootCause: await heuristicDeepRca(deps, c), source: 'heuristic' };
  }
  if (referencesAreReal(deps, rc))
    rc.evidence = rc.evidence.filter((e) =>
      Object.values(deps.config.web).some((b) => e.web_url.startsWith(b)),
    );
  deps.store.event(
    c,
    'llm',
    `AI deep RCA: ${out.usage.turns} turns, $${out.usage.costUsd.toFixed(3)}`,
  );
  return { rootCause: rc, source: 'llm' };
}

/** Log signals for the case (helper for prompts and tests). */
export function caseLogSignals(c: Case): LogSignal[] {
  return c.signals.filter((s): s is LogSignal => s.source === 'logs');
}
