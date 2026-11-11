/**
 * Caller incidents (#25). While an outage is on, bankers phone, email and chat the service desk,
 * each describing a different symptom. Related calls become children of the case's incident so
 * comments and the resolution reach every caller. Checked until the case is resolved.
 */
import { z } from 'zod';
import type { Case, HumanSignal } from '../cases/types';
import { errorMessage, hhmm, isoNow } from '../util';
import type { FlowDeps } from './steps';

export interface CallRow {
  number: string;
  short_description: string;
  description?: string;
  app_tla?: string | null;
  contact_type?: string;
  category?: string;
  caller?: string | { username: string; name?: string } | null;
  opened_at: string;
  web_url?: string;
  location?: string | null;
}

export interface Verdict {
  number: string;
  related: boolean;
  reason: string;
}

const STOP = new Set(
  'about after again also because been before being cannot could does from have having into just more most only other over same some such than that their them then there these they this those through under until very were what when where which while will with would your please help issue issues problem problems working work works getting since today still says said branch customer customers system'.split(
    ' ',
  ),
);

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])
      .map((w) => w.replace(/'s$/, ''))
      .filter((w) => !STOP.has(w)),
  );
}

/** Words that describe this problem: app names, the summary, signatures, the calls already grouped. */
export function caseVocabulary(deps: FlowDeps, c: Case): Set<string> {
  const graph = deps.graph();
  const texts: string[] = [c.scope?.summary ?? '', c.scope?.customer_impact ?? ''];
  for (const a of c.scope?.affected_apps ?? [])
    texts.push(a.name, graph.nodes.get(a.tla)?.service?.replace(/-/g, ' ') ?? '');
  for (const s of c.scope?.signatures ?? []) texts.push(s.message);
  for (const s of c.signals)
    if (s.source === 'human') texts.push(s.short_description, s.description);
  const out = new Set<string>();
  for (const t of texts) for (const w of words(t)) out.add(w);
  return out;
}

/** Deterministic relatedness: timing, the app, and shared vocabulary. */
export function heuristicVerdict(
  _deps: FlowDeps,
  c: Case,
  call: CallRow,
  vocab: Set<string>,
): Verdict {
  const onset = Date.parse(c.scope?.onset ?? c.onset_at ?? c.opened_at);
  if (Date.parse(call.opened_at) < onset - 10 * 60_000)
    return {
      number: call.number,
      related: false,
      reason: `opened at ${hhmm(call.opened_at)}, before the problem started`,
    };
  if (call.app_tla && (c.apps.includes(call.app_tla) || c.root_cause?.culprit_tla === call.app_tla))
    return {
      number: call.number,
      related: true,
      reason: `logged against ${call.app_tla}, which is part of the incident`,
    };
  if (call.app_tla && !c.apps.includes(call.app_tla) && call.category === 'hardware')
    return { number: call.number, related: false, reason: `a hardware problem on ${call.app_tla}` };
  const text = `${call.short_description} ${call.description ?? ''}`;
  const overlap = [...words(text)].filter((w) => vocab.has(w));
  const attached = c.signals.some((s) => s.source === 'human' && s.incident_number === call.number);
  if (overlap.length >= 2 || (overlap.length >= 1 && attached))
    return {
      number: call.number,
      related: true,
      reason: `describes the same symptoms (${overlap.slice(0, 4).join(', ')})`,
    };
  return {
    number: call.number,
    related: false,
    reason: overlap.length
      ? `only "${overlap[0]}" in common`
      : 'nothing in common with the incident',
  };
}

const Verdicts = z.object({
  verdicts: z.array(z.object({ number: z.string(), related: z.boolean(), reason: z.string() })),
});

/** Classifies candidate calls (LLM when available, else heuristic). */
export async function classifyCalls(deps: FlowDeps, c: Case, calls: CallRow[]): Promise<Verdict[]> {
  const vocab = caseVocabulary(deps, c);
  const draft = calls.map((call) => heuristicVerdict(deps, c, call, vocab));
  if (!deps.runner || calls.length === 0) return draft;
  const out = await deps.runner.run({
    name: 'grouping',
    caseId: c.id,
    system:
      'You decide which help-desk incidents (calls, emails, chats from bank staff) are symptoms of an ongoing outage. Staff describe symptoms in their own words and may blame the wrong thing (a printer, a drawer). Judge by what is actually failing, the apps involved and timing. Answer with JSON only.',
    prompt: [
      `Outage: ${c.scope?.summary ?? ''}. ${c.scope?.customer_impact ?? ''}`,
      `Since ${c.scope?.onset ?? c.onset_at}. Apps: ${(c.scope?.affected_apps ?? []).map((a) => `${a.tla} ${a.name}`).join(', ')}.`,
      c.root_cause ? `Root cause: ${c.root_cause.mechanism}` : '',
      'Candidate incidents:',
      ...calls.map(
        (x) =>
          `- ${x.number} opened ${x.opened_at} via ${x.contact_type} app=${x.app_tla ?? 'none'}: ${x.short_description}. ${x.description ?? ''}`,
      ),
      `A first pass said: ${JSON.stringify(draft)}`,
      'Return {"verdicts": [{"number", "related", "reason"}]} for every candidate.',
    ]
      .filter(Boolean)
      .join('\n'),
    tools: [],
    schema: Verdicts,
    maxTurns: 2,
    timeoutMs: 60_000,
  });
  if (!out.ok) return draft;
  return calls.map(
    (call) =>
      out.value.verdicts.find((v) => v.number === call.number) ??
      draft.find((d) => d.number === call.number)!,
  );
}

function callerName(call: CallRow): string | null {
  return typeof call.caller === 'string' ? call.caller : (call.caller?.username ?? null);
}

/** Candidate calls: standalone human incidents since just before the onset, plus attached signals. */
export async function candidateCalls(deps: FlowDeps, c: Case): Promise<CallRow[]> {
  const onset = Date.parse(c.scope?.onset ?? c.onset_at ?? c.opened_at);
  const res = await deps.mcp.call<{ items: CallRow[] }>(
    'list_incidents',
    {
      active: true,
      opened_after: new Date(onset - 30 * 60_000).toISOString(),
      contact_type: ['phone', 'email', 'chat'],
      relationship: 'standalone',
      limit: 50,
    },
    { caseId: c.id, quiet: true },
  );
  const skip = new Set([c.incident?.number, ...c.children, ...c.not_children]);
  const rows = (res.items ?? []).filter((r) => !skip.has(r.number));
  for (const s of c.signals) {
    if (
      s.source !== 'human' ||
      skip.has(s.incident_number) ||
      rows.some((r) => r.number === s.incident_number)
    )
      continue;
    rows.push(fromSignal(s));
  }
  // Descriptions are not in the list rows.
  for (const r of rows) {
    if (r.description !== undefined) continue;
    try {
      const full = await deps.mcp.call<{ description?: string; category?: string }>(
        'get_incident',
        { number: r.number },
        { caseId: c.id, quiet: true },
      );
      r.description = full.description ?? '';
      r.category ??= full.category;
    } catch {
      r.description = '';
    }
  }
  return rows;
}

function fromSignal(s: HumanSignal): CallRow {
  return {
    number: s.incident_number,
    short_description: s.short_description,
    description: s.description,
    app_tla: s.app_tla,
    contact_type: s.contact_type,
    caller: s.caller,
    opened_at: s.at,
    web_url: s.web_url,
    location: s.location,
  };
}

export interface GroupResult {
  added: { number: string; location: string | null }[];
  rejected: Verdict[];
}

/** Links related calls under the case's incident. Idempotent: decided calls are remembered. */
export async function groupCallers(deps: FlowDeps, c: Case): Promise<GroupResult> {
  if (!c.incident) return { added: [], rejected: [] };
  const calls = await candidateCalls(deps, c);
  if (calls.length === 0) return { added: [], rejected: [] };
  const verdicts = await classifyCalls(deps, c, calls);
  const related = verdicts.filter((v) => v.related);
  const rejected = verdicts.filter((v) => !v.related);
  const added: GroupResult['added'] = [];
  if (related.length) {
    const firstTime = c.children.length === 0;
    try {
      await deps.mcp.call(
        'link_child_incidents',
        {
          parent: c.incident.number,
          children: related.map((v) => v.number),
          work_note: `Grouped as the same problem: ${related.map((v) => `${v.number} (${v.reason})`).join('; ')}`,
          child_comment: `We're aware of this issue and are working on it under ${c.incident.number}. We'll update you here when it's fixed.`,
        },
        { caseId: c.id },
      );
    } catch (err) {
      // One bad child (already grouped elsewhere) shouldn't block the rest.
      deps.log.warn(`${c.id} link_child_incidents: ${errorMessage(err)}; linking one by one`);
      for (const v of [...related]) {
        try {
          await deps.mcp.call(
            'link_child_incidents',
            { parent: c.incident.number, children: [v.number] },
            { caseId: c.id },
          );
        } catch {
          related.splice(related.indexOf(v), 1);
          c.not_children.push(v.number);
        }
      }
    }
    for (const v of related) {
      c.children.push(v.number);
      const call = calls.find((x) => x.number === v.number);
      added.push({
        number: v.number,
        location: call?.location ?? callerName(call ?? ({} as CallRow)),
      });
    }
    if (firstTime && related.length) {
      await deps.mcp.call(
        'update_incident',
        {
          number: c.incident.number,
          comment: `We're aware that ${c.scope?.summary?.toLowerCase() ?? 'some services are failing'} and are working on a fix. Updates will follow here.`,
        },
        { caseId: c.id },
      );
    }
  }
  for (const v of rejected) if (!c.not_children.includes(v.number)) c.not_children.push(v.number);
  c.milestones.callers_checked = isoNow();
  deps.store.save(c);
  if (added.length)
    deps.store.event(
      c,
      'action',
      `Grouped ${added.length} call(s) under ${c.incident.number}: ${related.map((v) => `${v.number} (${v.reason})`).join('; ')}`,
      { url: c.incident.web_url },
    );
  if (rejected.length)
    deps.store.event(
      c,
      'decision',
      `Not grouped: ${rejected.map((v) => `${v.number} (${v.reason})`).join('; ')}`,
    );
  return { added, rejected };
}
