/**
 * What the live timeline (#27) shows: a summary per case for the list, and a page-ready view with
 * every record the case touched (incident, channel, MRs, change requests, alerts, log searches)
 * turned into a link. Pure functions of a Case, so the agent process and `pnpm agent timeline`
 * (reading the store from disk) render the same thing.
 */
import { type SystemName, URLS } from '@sim/contracts';
import { caseLinks } from '../cases/cli';
import { type Case, isTerminal, type Phase, type TimelineEvent } from '../cases/types';

/** UI bases of the four systems, to say where a link leads. */
export type WebBases = Partial<Record<SystemName, string>>;

/** Same tones as @sim/ui's StatusBadge. */
export type Tone = 'neutral' | 'negative' | 'warning' | 'positive' | 'info' | 'accent';

export interface Link {
  label: string;
  url: string;
  system: SystemName | null;
  title?: string;
}

export interface Stage {
  label: string;
  tone: Tone;
  state: 'done' | 'current' | 'todo' | 'failed' | 'stopped';
}

export interface Hypothesis {
  /** `root_cause` from the deep pass, else the quick pass's top suspect. */
  source: 'root_cause' | 'suspect';
  tla: string;
  confidence: number;
  text: string;
  author: string | null;
  promoted_at: string | null;
  links: Link[];
  evidence: Link[];
  ruled_out: string[];
  unexplained: string[];
  others: { tla: string; confidence: number; change: string | null }[];
}

export interface CaseSummary {
  id: string;
  kind: Case['kind'];
  phase: Phase;
  open: boolean;
  tone: Tone;
  opened_at: string;
  updated_at: string;
  onset_at: string | null;
  title: string;
  impact: string | null;
  apps: string[];
  stages: Stage[];
  hypothesis: Hypothesis | null;
  /** Background tasks still running (e.g. deep RCA). */
  background: { name: string; label: string; started_at: string; runs: number }[];
  /** The case's records: incident, channel, fix MR, change, caller incidents, alerts. */
  links: Link[];
  failure: string | null;
  related: { label: string; id: string }[];
  events: number;
  last_event: { at: string; kind: TimelineEvent['kind']; text: string } | null;
}

export interface ViewEvent {
  at: string;
  kind: TimelineEvent['kind'];
  text: string;
  links: Link[];
}

export interface CaseView extends CaseSummary {
  log_links: Link[];
  /** Record names that appear in event text (INC…, CHG…, project!iid, #channel) → URL. */
  refs: [string, string][];
  /** Chronological. */
  timeline: ViewEvent[];
}

const STAGES: { label: string; tone: Tone; phases: Phase[] }[] = [
  { label: 'Detect & triage', tone: 'negative', phases: ['detected', 'triaged'] },
  { label: 'Incident & channel', tone: 'warning', phases: ['declared', 'assembled', 'briefed'] },
  { label: 'Root cause', tone: 'accent', phases: ['investigating'] },
  { label: 'Fix & ship', tone: 'info', phases: ['fix_proposed', 'awaiting_merge', 'shipping'] },
  { label: 'Verify & resolve', tone: 'positive', phases: ['verifying', 'resolution_drafted'] },
];
const PATH: Phase[] = STAGES.flatMap((s) => s.phases);

const SYSTEM_LABEL: Record<SystemName, string> = {
  logs: 'Logs',
  servicenow: 'ServiceNow',
  gitlab: 'GitLab',
  teams: 'Teams',
};

const TASK_LABEL: Record<string, string> = { deep_rca: 'Deep root-cause analysis' };

/** The world's UI bases (local ports, or SIM_PUBLIC_URL path prefixes). */
export function defaultWeb(): WebBases {
  return {
    logs: URLS.logs.web,
    servicenow: URLS.servicenow.web,
    gitlab: URLS.gitlab.web,
    teams: URLS.teams.web,
  };
}

function systemOf(url: string, web: WebBases): SystemName | null {
  for (const [name, base] of Object.entries(web) as [SystemName, string | undefined][]) {
    if (!base) continue;
    const b = base.replace(/\/+$/, '');
    if (url === b || url.startsWith(`${b}/`) || url.startsWith(`${b}?`)) return name;
  }
  return null;
}

const mrLabel = (mr: { project: string; iid: number }) => `${mr.project}!${mr.iid}`;

function dedupe(links: Link[], max = Number.POSITIVE_INFINITY): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const l of links) {
    if (seen.has(l.url) || out.length >= max) continue;
    seen.add(l.url);
    out.push(l);
  }
  return out;
}

/** Where the case got to on the happy path; failed and abandoned cases stop there. */
function reached(c: Case): Phase | null {
  if (PATH.includes(c.phase)) return c.phase;
  if (c.failure && PATH.includes(c.failure.phase)) return c.failure.phase;
  let best = -1;
  for (const p of Object.keys(c.milestones)) best = Math.max(best, PATH.indexOf(p as Phase));
  return best >= 0 ? PATH[best]! : null;
}

function stages(c: Case): Stage[] {
  if (c.phase === 'resolved')
    return STAGES.map(({ label, tone }) => ({ label, tone, state: 'done' }));
  const at = reached(c);
  const current = at ? STAGES.findIndex((s) => s.phases.includes(at)) : -1;
  const here: Stage['state'] =
    c.phase === 'failed' ? 'failed' : c.phase === 'abandoned' ? 'stopped' : 'current';
  return STAGES.map(({ label, tone }, i) => ({
    label,
    tone,
    state: i < current ? 'done' : i === current ? here : 'todo',
  }));
}

function toneOf(c: Case): Tone {
  if (c.phase === 'resolved' || c.phase === 'resolution_drafted') return 'positive';
  if (c.phase === 'failed') return 'negative';
  if (c.phase === 'abandoned') return 'neutral';
  return STAGES.find((s) => s.phases.includes(c.phase))?.tone ?? 'neutral';
}

function titleOf(c: Case): string {
  if (c.scope?.summary) return c.scope.summary;
  const human = c.signals.find((s) => s.source === 'human');
  if (human?.source === 'human') return human.short_description;
  if (c.apps.length) return `Errors in ${c.apps.join(', ')}`;
  return c.kind === 'human-reported' ? 'Help desk report' : 'New signal';
}

/** Record name → URL, for linking names that appear in event text. */
function refs(c: Case): Map<string, string> {
  const map = new Map<string, string>();
  const add = (name: string | null | undefined, url: string | null | undefined) => {
    if (name && url && !map.has(name)) map.set(name, url);
  };
  for (const [label, url] of caseLinks(c)) add(label, url);
  if (c.channel) add(c.channel.name, c.channel.web_url);
  const rc = c.root_cause;
  if (rc) {
    add(rc.change_request?.number, rc.change_request?.web_url);
    if (rc.merge_request) add(mrLabel(rc.merge_request), rc.merge_request.web_url);
    if (rc.commit) {
      add(rc.commit.sha, rc.commit.web_url);
      add(rc.commit.sha.slice(0, 8), rc.commit.web_url);
    }
  }
  for (const s of c.suspects) {
    add(s.change_request?.number, s.change_request?.web_url);
    if (s.merge_request) add(mrLabel(s.merge_request), s.merge_request.web_url);
  }
  for (const s of c.signals) if (s.source === 'human') add(s.incident_number, s.web_url);
  return map;
}

/** URL → record name, for labelling links (the first name wins: `#channel` over `channel`). */
function urlNames(c: Case, named: Map<string, string>): Map<string, string> {
  const byUrl = new Map<string, string>();
  const add = (url: string, name: string) => {
    if (!byUrl.has(url)) byUrl.set(url, name);
  };
  for (const [name, url] of named) add(url, name);
  for (const a of c.alerts) add(a.web_url, `Alert ${a.id}`);
  for (const s of c.signals) if (s.source === 'alert') add(s.web_url, `Alert ${s.alert_id}`);
  return byUrl;
}

function linkTo(url: string, byUrl: Map<string, string>, web: WebBases): Link {
  const system = systemOf(url, web);
  return { label: byUrl.get(url) ?? (system ? SYSTEM_LABEL[system] : 'Link'), url, system };
}

const URL_KEYS = ['web_url', 'logs_url', 'url'];

/** Links inside an event's data (e.g. triage's log_links), labelled from sibling fields. */
function dataLinks(data: unknown, byUrl: Map<string, string>, web: WebBases, depth = 0): Link[] {
  if (depth > 4 || data === null || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data.flatMap((d) => dataLinks(d, byUrl, web, depth + 1));
  const obj = data as Record<string, unknown>;
  const out: Link[] = [];
  for (const key of URL_KEYS) {
    const url = obj[key];
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    const named = [obj.label, obj.number, obj.name, obj.title].find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    const mr =
      typeof obj.project === 'string' && typeof obj.iid === 'number'
        ? `${obj.project}!${obj.iid}`
        : undefined;
    const link = linkTo(url, byUrl, web);
    out.push({ ...link, label: byUrl.get(url) ?? named ?? mr ?? link.label });
  }
  for (const [key, value] of Object.entries(obj))
    if (!URL_KEYS.includes(key)) out.push(...dataLinks(value, byUrl, web, depth + 1));
  return out;
}

function hypothesis(c: Case, byUrl: Map<string, string>, web: WebBases): Hypothesis | null {
  const link = (label: string, url: string, title?: string): Link => ({
    label,
    url,
    system: systemOf(url, web),
    ...(title ? { title } : {}),
  });
  const rc = c.root_cause;
  const top = c.suspects[0];
  const lead = rc?.culprit_tla ?? top?.tla;
  const others = c.suspects
    .filter((s) => s.tla !== lead)
    .map((s) => ({
      tla: s.tla,
      confidence: s.confidence,
      change: s.change_request?.number ?? null,
    }));
  if (rc) {
    const match = c.suspects.find((s) => s.tla === rc.culprit_tla);
    const links: Link[] = [];
    if (rc.change_request) links.push(link(rc.change_request.number, rc.change_request.web_url));
    if (rc.merge_request)
      links.push(link(mrLabel(rc.merge_request), rc.merge_request.web_url, rc.merge_request.title));
    if (rc.commit) links.push(link(rc.commit.sha.slice(0, 8), rc.commit.web_url));
    return {
      source: 'root_cause',
      tla: rc.culprit_tla,
      confidence: rc.confidence,
      text: rc.mechanism,
      author: match?.author ?? null,
      promoted_at: match?.promoted_at ?? null,
      links: dedupe(links),
      evidence: dedupe(
        rc.evidence.map((e) => ({ ...linkTo(e.web_url, byUrl, web), label: e.claim })),
      ),
      ruled_out: rc.ruled_out.map((r) => `${r.ref}: ${r.reason}`),
      unexplained: rc.unexplained_apps.map((u) => `${u.tla}: ${u.reason}`),
      others,
    };
  }
  if (!top) return null;
  const links: Link[] = [];
  if (top.change_request) links.push(link(top.change_request.number, top.change_request.web_url));
  if (top.merge_request)
    links.push(
      link(mrLabel(top.merge_request), top.merge_request.web_url, top.merge_request.title),
    );
  return {
    source: 'suspect',
    tla: top.tla,
    confidence: top.confidence,
    text: top.reason,
    author: top.author,
    promoted_at: top.promoted_at,
    links,
    evidence: [],
    ruled_out: [],
    unexplained: [],
    others,
  };
}

function recordLinks(c: Case, web: WebBases): Link[] {
  const links: Link[] = caseLinks(c).map(([label, url]) => ({
    label,
    url,
    system: systemOf(url, web),
  }));
  const callers = new Map<string, string>();
  for (const s of c.signals) if (s.source === 'human') callers.set(s.incident_number, s.web_url);
  for (const n of c.children) {
    const url = callers.get(n);
    if (url) links.push({ label: n, url, system: systemOf(url, web), title: 'Child incident' });
  }
  for (const [n, url] of callers)
    links.push({ label: n, url, system: systemOf(url, web), title: 'Reported by a caller' });
  for (const a of c.alerts)
    links.push({
      label: `Alert ${a.id}`,
      url: a.web_url,
      system: systemOf(a.web_url, web),
      title: `Moogsoft alert on ${a.app_tla}${a.resolved ? ' (resolved)' : ''}`,
    });
  return dedupe(links);
}

export function caseSummary(c: Case, web: WebBases = defaultWeb()): CaseSummary {
  const byUrl = urlNames(c, refs(c));
  const last = c.timeline.at(-1);
  const related: CaseSummary['related'] = [];
  if (c.merged_into) related.push({ label: 'Merged into', id: c.merged_into });
  if (c.split_from) related.push({ label: 'Split from', id: c.split_from });
  return {
    id: c.id,
    kind: c.kind,
    phase: c.phase,
    open: !isTerminal(c.phase),
    tone: toneOf(c),
    opened_at: c.opened_at,
    updated_at: c.updated_at,
    onset_at: c.onset_at ?? c.scope?.onset ?? null,
    title: titleOf(c),
    impact: c.scope?.customer_impact ?? null,
    apps: c.apps,
    stages: stages(c),
    hypothesis: hypothesis(c, byUrl, web),
    background: Object.entries(c.background)
      .filter(([, t]) => t.state === 'running')
      .map(([name, t]) => ({
        name,
        label: TASK_LABEL[name] ?? name.replace(/_/g, ' '),
        started_at: t.started_at,
        runs: t.runs,
      })),
    links: recordLinks(c, web),
    failure: c.failure ? `${c.failure.reason} (during ${c.failure.phase})` : null,
    related,
    events: c.timeline.length,
    last_event: last ? { at: last.at, kind: last.kind, text: last.text } : null,
  };
}

export function caseView(c: Case, web: WebBases = defaultWeb()): CaseView {
  const named = refs(c);
  const byUrl = urlNames(c, named);
  const logLinks: Link[] = (c.scope?.log_links ?? []).map((l) => ({
    label: l.label,
    url: l.logs_url,
    system: 'logs',
    title: l.filter,
  }));
  if (c.verification?.logs_url)
    logLinks.push({ label: 'Recovery check', url: c.verification.logs_url, system: 'logs' });
  return {
    ...caseSummary(c, web),
    log_links: dedupe(logLinks),
    refs: [...named],
    timeline: c.timeline.map((e) => ({
      at: e.at,
      kind: e.kind,
      text: e.text,
      links: dedupe(
        [
          ...(e.url ? [linkTo(e.url, byUrl, web)] : []),
          // Tool events carry call arguments, not results: nothing worth linking.
          ...(e.kind === 'tool' ? [] : dataLinks(e.data, byUrl, web)),
        ],
        6,
      ),
    })),
  };
}

/** Open cases first (newest first), then closed ones by latest activity. */
export function ordered(cases: Case[]): Case[] {
  return [...cases].sort((a, b) => {
    const closed = Number(isTerminal(a.phase)) - Number(isTerminal(b.phase));
    if (closed) return closed;
    return isTerminal(a.phase)
      ? b.updated_at.localeCompare(a.updated_at)
      : b.opened_at.localeCompare(a.opened_at);
  });
}
