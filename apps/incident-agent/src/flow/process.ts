/**
 * The critical incident process around the fix: the recorded call, the Critical Incident
 * Communication drafts, the incident's Resolution section and the problem record for the daily
 * problem stand-up. The prose is the model's (plain business language); every number, time and
 * link comes from the case. Each step is best effort: none of them may stop the incident from
 * being worked, and each can run again without creating anything twice.
 */
import { z } from 'zod';
import type { Case } from '../cases/types';
import { McpToolError } from '../mcp/gateway';
import { duration, errorMessage, isoNow, slugify } from '../util';
import { priorityOf } from './assemble';
import type { FlowDeps } from './steps';

/** "3:06 PM ET": the bank writes incident times in Eastern. */
export function et(iso: string | null | undefined): string {
  if (!iso) return 'an unknown time';
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  }).format(new Date(iso));
  return `${time} ET`;
}

export function casePriority(c: Case): number {
  return (
    c.incident?.priority ??
    priorityOf(c.scope?.suggested_impact ?? 3, c.scope?.suggested_urgency ?? 3)
  );
}

const onsetOf = (c: Case) => c.scope?.onset ?? c.onset_at ?? c.opened_at;
const restoredAt = (c: Case) =>
  c.verification?.healthy_since ?? c.milestones.resolution_drafted ?? isoNow();

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * What a communication names: the configuration item and the apps triage found failing, not the
 * whole downstream tail (the incident's Affected CIs list carries that).
 */
export function systemsNamed(c: Case, max = 8): string[] {
  const apps = [c.incident?.app_tla, ...(c.scope?.affected_apps ?? []).map((a) => a.tla)];
  const named = [...new Set(apps.filter((a): a is string => Boolean(a)))];
  return (named.length ? named : systemsImpacted(c)).slice(0, max);
}

/** The incident's configuration item first, then every other affected app. */
export function systemsImpacted(c: Case): string[] {
  const apps = [
    c.incident?.app_tla,
    ...(c.scope?.affected_apps ?? []).map((a) => a.tla),
    ...c.apps,
  ];
  return [...new Set(apps.filter((a): a is string => Boolean(a)))];
}

// ---------------------------------------------------------------------------
// The incident record: Affected CIs and "cause identified"
// ---------------------------------------------------------------------------

/** Keeps the incident's Affected CIs and cause fields in step with the case (upkeep). */
export async function syncIncidentRecord(deps: FlowDeps, c: Case): Promise<void> {
  if (!c.incident) return;
  const cis = systemsImpacted(c).filter((t) => t !== c.incident?.app_tla);
  const rc = c.root_cause;
  const cause =
    rc && rc.confidence >= deps.config.rcaConfidence
      ? `${rc.culprit_tla}:${rc.change_request?.number ?? ''}`
      : '';
  const key = `${c.incident.app_tla ?? ''}|${[...cis].sort().join(',')}|${cause}`;
  if (c.milestones.record_key === key) return;
  const args: Record<string, unknown> = { number: c.incident.number, affected_cis: cis };
  if (c.milestones.record_key === undefined) args.outage_start = onsetOf(c);
  if (cause && rc) {
    args.cause_code = rc.change_request ? 'Change' : 'Software defect';
    if (rc.change_request) args.caused_by_change = rc.change_request.number;
    args.root_cause = rc.mechanism;
    if (!c.milestones.cause_identified)
      args.work_note = `Cause identified: ${rc.culprit_tla} ${rc.change_request?.number ?? ''} ${rc.merge_request?.web_url ?? ''}. ${rc.mechanism}`;
  }
  try {
    await deps.mcp.call('update_incident', args, { caseId: c.id });
    c.milestones.record_key = key;
    if (cause && !c.milestones.cause_identified) {
      c.milestones.cause_identified = isoNow();
      deps.store.event(
        c,
        'action',
        `Recorded the cause on ${c.incident.number}: cause code ${String(args.cause_code)}${rc?.change_request ? `, caused by ${rc.change_request.number}` : ''}`,
        { url: c.incident.web_url },
      );
    }
    deps.store.save(c);
  } catch (err) {
    deps.log.warn(`${c.id} incident record sync failed: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// The recorded call
// ---------------------------------------------------------------------------

interface MeetingResult {
  meeting?: { id: string; started_at: string; join_url?: string; ended_at?: string | null };
  already_running?: boolean;
}

/** Turns the incident channel into a recorded, transcribed call (P1 and P2). */
export async function startMeeting(deps: FlowDeps, c: Case): Promise<boolean> {
  if (!c.channel || c.meeting || casePriority(c) > 2) return false;
  try {
    const res = await deps.mcp.call<MeetingResult>(
      'start_meeting',
      {
        channel: c.channel.id,
        title:
          `${c.incident?.number ?? 'Incident'} bridge: ${c.scope?.summary ?? 'incident call'}`.slice(
            0,
            120,
          ),
        record: true,
        transcribe: true,
        facilitator: true,
      },
      { caseId: c.id },
    );
    if (!res.meeting) return false;
    c.meeting = {
      id: res.meeting.id,
      started_at: res.meeting.started_at,
      ended_at: null,
      join_url: res.meeting.join_url ?? c.channel.web_url,
    };
    c.milestones.meeting_started = isoNow();
    deps.store.event(
      c,
      'action',
      `Turned #${c.channel.name} into a call: recording, transcription and the Facilitator are on; ${c.members.length} people prompted to join`,
      { url: c.meeting.join_url },
    );
    deps.store.save(c);
    return true;
  } catch (err) {
    deps.store.event(c, 'error', `Could not start the call: ${errorMessage(err)}`);
    return false;
  }
}

export async function endMeeting(deps: FlowDeps, c: Case): Promise<void> {
  if (!c.channel || !c.meeting || c.meeting.ended_at) return;
  try {
    await deps.mcp.call('end_meeting', { channel: c.channel.id }, { caseId: c.id });
  } catch (err) {
    // Someone ended it already: that is the state we wanted.
    if (!(err instanceof McpToolError)) {
      deps.log.warn(`${c.id} end_meeting failed: ${errorMessage(err)}`);
      return;
    }
  }
  c.meeting.ended_at = isoNow();
  deps.store.event(c, 'action', 'Ended the call; the recording and transcript stay in the channel');
  deps.store.save(c);
}

// ---------------------------------------------------------------------------
// The prose: communications, the Resolution section and the problem record
// ---------------------------------------------------------------------------

export const ProcessText = z.object({
  title: z
    .string()
    .describe(
      'Headline for the email subject: names the issue only, never its state (no "Restored" or "Resolved"). At most 7 words, Title Case, no incident number, e.g. "CE Desktop Performance Degradation"',
    ),
  description: z
    .string()
    .describe(
      '2-3 short sentences (at most 55 words) for a business audience: when it started (Eastern time), what is or was happening, to which systems, and when support teams were engaged',
    ),
  client_impact: z
    .string()
    .describe('One sentence. "There was no client impact." when clients were not affected'),
  employee_impact: z.string().describe('One sentence on what employees could not do'),
  cause: z
    .string()
    .describe(
      'One or two plain sentences, at most 35 words. "The cause is under investigation." when not known',
    ),
  resolution_activities: z
    .string()
    .describe(
      'At most 45 words: what was done to restore service and what happens next; empty while still active',
    ),
  root_cause: z
    .string()
    .describe(
      'Technical root cause for the problem record, 2-3 sentences and at most 60 words: the change and how it broke its callers',
    ),
  mitigation_plan: z
    .string()
    .describe(
      'At most 45 words: what restored service, and what remains to make the fix permanent',
    ),
  action_items: z
    .string()
    .describe(
      '2-3 follow-up actions that would prevent a repeat, one per line starting with "- ", each at most 14 words',
    ),
});
export type ProcessText = z.infer<typeof ProcessText>;

type TextKind = 'new' | 'restored';

function facts(deps: FlowDeps, c: Case, kind: TextKind): string[] {
  const graph = deps.graph();
  const s = c.scope;
  const rc = c.root_cause;
  const m = c.milestones;
  const callers = c.signals.filter((x) => x.source === 'human');
  const lines = [
    `Incident ${c.incident?.number ?? ''}, priority ${casePriority(c)}: ${s?.summary ?? ''}`,
    `Started: ${et(onsetOf(c))}.`,
    m.assembled ? `Incident Management engaged support teams at ${et(m.assembled)}.` : '',
    `Impact as triaged: ${s?.customer_impact ?? 'being assessed'}`,
    `Systems: ${systemsNamed(c)
      .map((t) => graph.label(t))
      .join(
        '; ',
      )}${systemsImpacted(c).length > systemsNamed(c).length ? `; and ${systemsImpacted(c).length - systemsNamed(c).length} more applications downstream of them` : ''}.`,
    callers.length
      ? `Staff reports to the help desk (${callers.length}): ${callers
          .slice(0, 5)
          .map((h) =>
            h.source === 'human' ? `"${h.short_description}" (${h.location ?? 'n/a'})` : '',
          )
          .join('; ')}`
      : 'No staff reports to the help desk.',
    rc
      ? `Root cause (${Math.round(rc.confidence * 100)}% confidence): change ${rc.change_request?.number ?? 'n/a'} to ${graph.label(rc.culprit_tla)}${rc.merge_request?.title ? ` ("${rc.merge_request.title}")` : ''}. ${rc.mechanism}`
      : c.suspects[0]
        ? `Leading suspect, not confirmed: ${c.suspects[0].change_request?.number ?? 'a change'} to ${graph.label(c.suspects[0].tla)}. ${c.suspects[0].reason}`
        : 'Cause: not known yet.',
  ];
  if (kind === 'restored') {
    lines.push(
      c.fix
        ? `Fix: ${c.fix.strategy} "${c.fix.title}". ${c.fix.justification}`
        : 'Fix: a corrective change.',
      c.fix_mr?.merged_at
        ? `A person reviewed and merged the fix at ${et(c.fix_mr.merged_at)}.`
        : '',
      c.change
        ? `Emergency change ${c.change.number} promoted it to production at ${et(c.change.deployed_at)}.`
        : '',
      `Service confirmed restored at ${et(restoredAt(c))} (${duration(Date.parse(restoredAt(c)) - Date.parse(onsetOf(c)))} after it started).`,
      c.verification
        ? `Errors on the affected systems fell from ${c.verification.before_per_min.toFixed(0)} to ${(c.verification.after_per_min ?? 0).toFixed(0)} a minute.`
        : '',
    );
  }
  return lines.filter(Boolean);
}

/** The same text without a model: assembled from the case. */
export function fallbackText(deps: FlowDeps, c: Case, kind: TextKind): ProcessText {
  const graph = deps.graph();
  const s = c.scope;
  const rc = c.root_cause;
  const systems = systemsImpacted(c).map((t) => graph.nodes.get(t)?.name ?? t);
  const callers = c.signals.filter((x) => x.source === 'human').length;
  const engaged = c.milestones.assembled
    ? ` Incident Management engaged support teams at ${et(c.milestones.assembled)}.`
    : '';
  const verb = kind === 'restored' ? 'were' : 'are';
  const cause = rc
    ? `A change to ${graph.nodes.get(rc.culprit_tla)?.name ?? rc.culprit_tla}${rc.change_request ? ` (${rc.change_request.number})` : ''} caused the failures. ${rc.mechanism}`
    : 'The cause is under investigation.';
  const fix = c.fix_mr
    ? `A corrective change${c.fix ? ` (${c.fix.strategy})` : ''} was reviewed and merged${c.change ? `, then promoted to production by emergency change ${c.change.number} at ${et(c.change.deployed_at)}` : ''}.`
    : 'Service was restored.';
  return {
    title: (s?.summary ?? `Errors on ${systems.slice(0, 3).join(', ')}`).slice(0, 90),
    description:
      `Starting at ${et(onsetOf(c))}, ${systems.length > 1 ? `${systems.length} systems` : (systems[0] ?? 'a system')} began failing: ${list(systems.slice(0, 6))}${systems.length > 6 ? ' and others' : ''}. ${s?.customer_impact ?? ''}`.trim() +
      engaged,
    client_impact: s?.customer_impact ?? 'Client impact is being assessed.',
    employee_impact: callers
      ? `Employees ${verb} unable to complete work in the affected systems; ${callers} report${callers === 1 ? '' : 's'} reached the help desk.`
      : `Employees using the affected systems ${verb} unable to complete some tasks.`,
    cause,
    resolution_activities:
      kind === 'restored'
        ? `${fix} Error rates returned to normal at ${et(restoredAt(c))}. Support teams are monitoring to confirm continued stability.`
        : '',
    root_cause: rc?.mechanism ?? 'Under investigation.',
    mitigation_plan: `${fix} Service confirmed restored at ${et(restoredAt(c))}.`,
    action_items: [
      '- Review why the change passed review and testing without the failure being caught',
      '- Add a contract test between the changed service and the applications that call it',
      '- Add monitoring on callers for this failure signature',
    ].join('\n'),
  };
}

/** One incident, one headline: later communications reuse the first one's. */
function sameTitle(c: Case, text: ProcessText): ProcessText {
  const first = c.communications.find((x) => x.title)?.title;
  return first ? { ...text, title: first } : text;
}

/** Writes the process prose: the model by default, assembled text as the fallback. */
export async function processText(
  deps: FlowDeps,
  c: Case,
  kind: TextKind,
): Promise<{ text: ProcessText; source: 'llm' | 'deterministic' }> {
  const fallback = () => ({
    text: sameTitle(c, fallbackText(deps, c, kind)),
    source: 'deterministic' as const,
  });
  if (!deps.runner) return fallback();
  const started = Date.now();
  const out = await deps.runner.run({
    name: kind === 'new' ? 'communication' : 'wrap-up',
    caseId: c.id,
    system:
      "You write a bank's Critical Incident Communication and incident paperwork. Readers are business and technology leaders: plain, calm, factual sentences, no jargon beyond system names, no speculation, no blame on individuals. Use only the facts given; never invent times, numbers, systems or causes. Write times in Eastern time exactly as given. Refer to systems by name with the three-letter code in brackets the first time. Answer with JSON only.",
    prompt: [
      kind === 'new'
        ? 'The incident is ACTIVE. Write the communication that announces it. Leave resolution_activities, mitigation_plan and action_items empty, and say the cause is under investigation unless the root cause below is confirmed.'
        : 'Service is RESTORED. Write the communication that closes the incident, the text for its Resolution section, and the problem record for the daily problem stand-up.',
      '',
      'Facts:',
      ...facts(deps, c, kind).map((l) => `- ${l}`),
    ].join('\n'),
    tools: [],
    schema: ProcessText,
    maxTurns: 2,
    timeoutMs: 60_000,
  });
  if (!out.ok) {
    deps.store.event(
      c,
      'llm',
      `AI ${kind} communication failed (${out.error}); using the template`,
    );
    return fallback();
  }
  deps.store.event(
    c,
    'llm',
    `Wrote the ${kind === 'new' ? 'incident communication' : 'resolution, problem record and closing communication'} (${Math.round((Date.now() - started) / 1000)}s, $${out.usage.costUsd.toFixed(3)})`,
  );
  // Empty answers fall back field by field.
  const base = fallbackText(deps, c, kind);
  const text = { ...out.value };
  for (const k of Object.keys(base) as (keyof ProcessText)[])
    if (!text[k]?.trim() && (kind === 'restored' || k === 'title' || k === 'description'))
      text[k] = base[k];
  return { text: sameTitle(c, text), source: 'llm' };
}

// ---------------------------------------------------------------------------
// Critical Incident Communications
// ---------------------------------------------------------------------------

interface CommunicationRow {
  number: string;
  web_url: string;
  subject?: string;
  to?: string;
  communication_specialist?: string | { username: string } | null;
}

/** Drafts the communication for the distribution group. A person reviews and sends it. */
export async function draftCommunication(
  deps: FlowDeps,
  c: Case,
  kind: TextKind,
  text: ProcessText,
): Promise<Case['communications'][number] | null> {
  if (!c.incident || casePriority(c) > 3) return null;
  const done = c.communications.find((x) => x.kind === kind);
  if (done) return done;
  try {
    const restored = kind === 'restored';
    const row = await deps.mcp.call<CommunicationRow>(
      'draft_incident_communication',
      {
        incident: c.incident.number,
        kind,
        title: text.title,
        description: text.description,
        systems_impacted: systemsNamed(c),
        start: onsetOf(c),
        ...(restored
          ? {
              resolved: restoredAt(c),
              client_impact: text.client_impact,
              employee_impact: text.employee_impact,
              cause: text.cause,
              resolution_activities: text.resolution_activities,
            }
          : {}),
      },
      { caseId: c.id },
    );
    const who = row.communication_specialist;
    const entry = {
      kind,
      number: row.number,
      web_url: row.web_url,
      subject: row.subject ?? '',
      title: text.title,
      to: row.to ?? '',
      specialist: (typeof who === 'string' ? who : who?.username) ?? null,
      drafted_at: isoNow(),
    };
    c.communications.push(entry);
    c.milestones[`communication_${kind}`] = entry.drafted_at;
    deps.store.event(
      c,
      'action',
      `Drafted the ${restored ? 'RESTORED' : 'NEW'} Critical Incident Communication ${row.number} for ${entry.to || 'the distribution group'}; a person sends it`,
      { url: row.web_url },
    );
    deps.store.save(c);
    return entry;
  } catch (err) {
    deps.store.event(c, 'error', `Could not draft the ${kind} communication: ${errorMessage(err)}`);
    return null;
  }
}

/** Brings the Communication Specialist into the chat, told why they are there. */
export async function inviteSpecialist(deps: FlowDeps, c: Case, username: string): Promise<void> {
  if (!c.channel || c.members.some((m) => m.username === username)) return;
  const reason =
    'Communication Specialist: please review and send the Critical Incident Communication draft';
  try {
    await deps.mcp.call(
      'add_channel_members',
      { channel: c.channel.id, members: [{ user: username, reason, role: 'member' }] },
      { caseId: c.id },
    );
    c.members.push({ username, reason, role: 'member' });
    deps.store.event(c, 'action', `Added ${username} (${reason}) to #${c.channel.name}`, {
      url: c.channel.web_url,
    });
    deps.store.save(c);
  } catch (err) {
    deps.log.warn(`${c.id} could not add ${username}: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// The Resolution section
// ---------------------------------------------------------------------------

/** The incident's Resolution section: what the stand-up and the communication read from. */
export function resolutionFields(c: Case, text: ProcessText): Record<string, string> {
  const rc = c.root_cause;
  const fields: Record<string, string | null | undefined> = {
    cause_code: rc ? (rc.change_request ? 'Change' : 'Software defect') : 'Under investigation',
    caused_by_change: rc?.change_request?.number,
    resolved_by_change: c.change?.number,
    outage_start: onsetOf(c),
    service_restored_at: restoredAt(c),
    root_cause: text.root_cause,
    client_impact: text.client_impact,
    employee_impact: text.employee_impact,
  };
  return Object.fromEntries(
    Object.entries(fields).filter((e): e is [string, string] => Boolean(e[1])),
  );
}

// ---------------------------------------------------------------------------
// The problem record and the chat's new name
// ---------------------------------------------------------------------------

interface ProblemRow {
  number: string;
  web_url: string;
  standup_date?: string | null;
}

/** Opens the problem record for the next daily problem stand-up (once per incident). */
export async function openProblem(deps: FlowDeps, c: Case, text: ProcessText): Promise<boolean> {
  if (!c.incident || c.problem) return false;
  try {
    const existing = await deps.mcp.call<{ items?: ProblemRow[] }>(
      'list_problems',
      { incident: c.incident.number, limit: 1 },
      { caseId: c.id, quiet: true },
    );
    let row = existing.items?.[0];
    if (!row) {
      const rc = c.root_cause;
      row = await deps.mcp.call<ProblemRow>(
        'create_problem',
        {
          short_description: text.title.slice(0, 160),
          description: text.description,
          incidents: [c.incident.number],
          ...(c.incident.app_tla ? { app_tla: c.incident.app_tla } : {}),
          cause_code: rc
            ? rc.change_request
              ? 'Change'
              : 'Software defect'
            : 'Under investigation',
          root_cause: text.root_cause,
          mitigation_plan: text.mitigation_plan,
          action_items: text.action_items,
          client_impact: text.client_impact,
          employee_impact: text.employee_impact,
          ...(rc?.change_request ? { caused_by_change: rc.change_request.number } : {}),
          ...(c.change ? { change_request: c.change.number } : {}),
          standup: true,
        },
        { caseId: c.id },
      );
    }
    c.problem = {
      number: row.number,
      web_url: row.web_url,
      standup_date: row.standup_date ?? null,
    };
    c.milestones.problem_opened = isoNow();
    deps.store.event(
      c,
      'action',
      `Opened problem ${row.number} for the 8:00 AM problem stand-up${row.standup_date ? ` on ${row.standup_date}` : ''}`,
      { url: row.web_url },
    );
    deps.store.save(c);
    return true;
  } catch (err) {
    deps.store.event(c, 'error', `Could not open the problem record: ${errorMessage(err)}`);
    return false;
  }
}

/** inc0010234-<slug> → inc0010234-prb0040001-<slug>, so the chat is found by either number. */
export function problemChannelName(c: Case): { name: string; display_name: string } | null {
  if (!c.incident || !c.problem) return null;
  const summary = c.scope?.summary ?? c.apps.join(' ');
  // The symptom, as in the channel's first name: "OLB, MBL and 4 more failing: <symptom>".
  const symptom = summary.includes(': ') ? summary.slice(summary.indexOf(': ') + 2) : summary;
  const prefix = `${c.incident.number.toLowerCase()}-${c.problem.number.toLowerCase()}-`;
  const slug = slugify(symptom, 50 - prefix.length) || 'incident';
  return {
    name: `${prefix}${slug}`.slice(0, 50).replace(/-+$/, ''),
    display_name: `${c.incident.number} · ${c.problem.number} ${summary}`.slice(0, 80),
  };
}

/** Renames the incident chat with the problem number. */
export async function renameForProblem(deps: FlowDeps, c: Case): Promise<boolean> {
  const next = problemChannelName(c);
  if (!c.channel || !next || c.channel.name === next.name) return false;
  try {
    const res = await deps.mcp.call<{
      channel?: { name?: string };
      name?: string;
    }>('update_channel', { channel: c.channel.id, ...next }, { caseId: c.id });
    const before = c.channel.name;
    c.channel = { ...c.channel, name: res.channel?.name ?? res.name ?? next.name };
    c.milestones.channel_renamed = isoNow();
    deps.store.event(c, 'action', `Renamed #${before} to #${c.channel.name}`, {
      url: c.channel.web_url,
    });
    deps.store.save(c);
    return true;
  } catch (err) {
    deps.store.event(c, 'error', `Could not rename the channel: ${errorMessage(err)}`);
    return false;
  }
}
