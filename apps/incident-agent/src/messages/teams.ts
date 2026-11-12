/**
 * Teams message templates (#20). Pure functions over the case: the LLM only ever wrote prose
 * fields (summary, customer impact, mechanism); every link is inserted here from the web_url /
 * logs_url the tools returned and stored on the case. Snapshot-tested.
 */
import type { Case, RootCause, Suspect } from '../cases/types';
import type { DependencyGraph } from '../correlate/graph';
import { duration, hhmm } from '../util';

export interface Message {
  body: string;
  mentions: string[];
  importance: 'normal' | 'high' | 'urgent';
}

const md = (label: string, url: string | null | undefined) => (url ? `[${label}](${url})` : label);
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function priority(c: Case): number {
  const sum = (c.scope?.suggested_impact ?? 3) + (c.scope?.suggested_urgency ?? 3);
  return sum <= 2 ? 1 : sum === 3 ? 2 : sum === 4 ? 3 : sum === 5 ? 4 : 5;
}

function importanceFor(c: Case): Message['importance'] {
  const p = priority(c);
  return p === 1 ? 'urgent' : p === 2 ? 'high' : 'normal';
}

/** On-call rep in the channel for an app (by the app's group on-call), if any. */
function repFor(c: Case, graph: DependencyGraph, tla: string): string | null {
  const node = graph.nodes.get(tla);
  const candidates = [node?.on_call?.primary, node?.on_call?.secondary].filter(Boolean) as string[];
  return candidates.find((u) => c.members.some((m) => m.username === u)) ?? null;
}

function changeLine(s: Suspect | RootCause, author: string | null): string {
  const chg = s.change_request
    ? md(s.change_request.number, s.change_request.web_url)
    : 'no change request';
  const mr = s.merge_request
    ? md(`${s.merge_request.project}!${s.merge_request.iid}`, s.merge_request.web_url) +
      (s.merge_request.title ? ` "${s.merge_request.title}"` : '')
    : '';
  return `${chg}${mr ? ` → ${mr}` : ''}${author ? ` by @${author}` : ''}`;
}

/** Who should be @mentioned in the briefing: the reps, the suspect team and the author. */
export function briefingMentions(c: Case): string[] {
  return c.members
    .filter((m) => /on-call for|author of|backup on-call/.test(m.reason))
    .map((m) => m.username);
}

/** The first message in the channel: what's broken, evidence, likely cause, what happens next. */
export function briefing(
  c: Case,
  graph: DependencyGraph,
  opts: { notInvited?: { user: string; reason: string }[] } = {},
): Message {
  const s = c.scope;
  const p = priority(c);
  const lines: string[] = [];
  lines.push(`## 🚨 P${p}: ${s?.summary ?? 'Incident'}`);
  lines.push('');
  lines.push(`**What's broken:** ${s?.customer_impact ?? 'Impact being assessed.'}`);
  lines.push(
    `**Since:** ${hhmm(s?.onset ?? c.onset_at)} · **Priority:** P${p} (${s?.severity_reason ?? 'n/a'})`,
  );
  if (c.incident) lines.push(`**Incident:** ${md(c.incident.number, c.incident.web_url)}`);

  const affected = (s?.affected_apps ?? []).filter((a) => a.error_count > 0);
  if (affected.length > 1) {
    lines.push('');
    lines.push(`**${affected.length} apps, one incident:**`);
    lines.push('');
    lines.push('| App | Errors | Since | Team rep |');
    lines.push('| --- | ---: | --- | --- |');
    for (const a of affected.slice(0, 10)) {
      const rep = repFor(c, graph, a.tla);
      lines.push(
        `| ${a.tla} ${a.name} | ${a.error_count.toLocaleString('en-US')} | ${hhmm(a.onset)} | ${rep ? `@${rep}` : '—'} |`,
      );
    }
    if (affected.length > 10) lines.push(`| … ${affected.length - 10} more | | | |`);
    const upstream = c.upstream_candidates.find((u) => u.covers === u.of && u.of > 1 && !u.failing);
    const evidence: string[] = [];
    if (upstream)
      evidence.push(
        `all ${affected.length} depend on ${graph.label(upstream.tla)}, which logs no errors itself`,
      );
    const reasons = c.relations.flatMap((r) => r.reasons);
    if (reasons.some((r) => r.includes('share traces')))
      evidence.push('failing requests share traces');
    const named = reasons.find((r) => r.startsWith('errors on both sides name'));
    if (named)
      evidence.push(`their errors name ${named.replace('errors on both sides name ', '')}`);
    const types = [...new Set((s?.signatures ?? []).map((x) => x.error_type).filter(Boolean))];
    if (types.length) evidence.push(`errors: ${types.slice(0, 3).join(', ')}`);
    lines.push('');
    lines.push(
      `**Why one incident:** ${evidence.join('; ') || 'they started failing together and are linked in the dependency graph'}.`,
    );
  }

  if (s?.log_links.length) {
    lines.push('');
    lines.push('**Logs** (query applied):');
    for (const l of s.log_links) lines.push(`- ${md(l.label, l.logs_url)}`);
  }

  lines.push('');
  const rc = c.root_cause;
  const top = c.suspects[0];
  if (rc) {
    lines.push(`**Root cause (${pct(rc.confidence)}):** ${changeLine(rc, null)}`);
    lines.push(rc.mechanism);
  } else if (top) {
    lines.push(`**Likely cause (${pct(top.confidence)}):** ${changeLine(top, top.author)}`);
    if (top.promoted_at)
      lines.push(`KBR promoted it to production at ${hhmm(top.promoted_at)}. ${top.reason}.`);
    else lines.push(`${top.reason}.`);
    if (c.suspects.length > 1)
      lines.push(
        `Also looked at: ${c.suspects
          .slice(1)
          .map(
            (x) =>
              `${x.tla} ${x.change_request ? md(x.change_request.number, x.change_request.web_url) : ''} (${pct(x.confidence)})`,
          )
          .join(', ')}.`,
      );
    lines.push('_Confirming in the background._');
  } else {
    lines.push(
      '**Likely cause:** no production change found near the onset yet; investigating upstream dependencies.',
    );
  }

  lines.push('');
  lines.push(
    '**What happens next:** I am preparing a fix merge request. When it is ready I will ask the owners to review it and click **Merge** in GitLab; I will then raise the emergency change and watch the recovery.',
  );
  if (affected.length > 1)
    lines.push("If one of these apps looks unrelated, say so here and I'll split it out.");
  if (opts.notInvited?.length)
    lines.push(
      `Not invited yet (ask and I'll add them): ${opts.notInvited.map((i) => `${i.user} (${i.reason})`).join('; ')}.`,
    );

  return { body: lines.join('\n'), mentions: briefingMentions(c), importance: importanceFor(c) };
}

export function rootCauseUpdate(
  _c: Case,
  rc: RootCause,
  previous: { tla: string; number?: string | null } | null,
): Message {
  const lines: string[] = [];
  if (previous && previous.tla !== rc.culprit_tla)
    lines.push(
      `**Root cause changed:** it's ${rc.culprit_tla}, not ${previous.tla}${previous.number ? ` (${previous.number})` : ''}.`,
    );
  else lines.push(`**Root cause confirmed (${pct(rc.confidence)}):** ${changeLine(rc, null)}`);
  if (previous && previous.tla !== rc.culprit_tla) lines.push(changeLine(rc, null));
  lines.push(rc.mechanism);
  if (rc.evidence.length) {
    lines.push('');
    for (const e of rc.evidence.slice(0, 4)) lines.push(`- ${md(e.claim, e.web_url)}`);
  }
  if (rc.ruled_out.length)
    lines.push(
      '',
      `Ruled out: ${rc.ruled_out
        .slice(0, 4)
        .map((r) => `${r.ref} (${r.reason})`)
        .join('; ')}.`,
    );
  if (rc.unexplained_apps.length)
    lines.push(
      '',
      `Not explained by this change: ${rc.unexplained_apps.map((u) => u.tla).join(', ')}. Looking at those separately.`,
    );
  return { body: lines.join('\n'), mentions: [], importance: 'normal' };
}

export function appsJoined(c: Case, graph: DependencyGraph, apps: string[]): Message {
  const lines = apps.map((tla) => {
    const rel = c.relations.find((r) => r.tla === tla);
    const rep = repFor(c, graph, tla);
    return `- ${graph.label(tla)}${rep ? ` (rep @${rep})` : ''}: ${rel?.reasons.slice(0, 2).join('; ') ?? 'same problem'}`;
  });
  return {
    body: [
      `**${apps.length === 1 ? 'Another app is' : `${apps.length} more apps are`} failing with the same cause:**`,
      ...lines,
    ].join('\n'),
    mentions: [],
    importance: 'normal',
  };
}

export function fixReady(c: Case, mentions: string[]): Message {
  const mr = c.fix_mr!;
  const fix = c.fix;
  return {
    body: [
      `**Fix ready for review:** ${md(`${mr.project}!${mr.iid}`, mr.web_url)}${fix ? ` "${fix.title}"` : ''}`,
      fix ? `Strategy: ${fix.strategy} (${fix.justification})` : '',
      `${mentions.map((m) => `@${m}`).join(' ')} please review and click **Merge** in GitLab. Merging deploys to QV; I'll prepare the emergency change to production right after.`,
    ]
      .filter(Boolean)
      .join('\n'),
    mentions,
    importance: importanceFor(c),
  };
}

export function changeRaised(c: Case, mentions: string[] = []): Message {
  return {
    body: [
      `**Merged. Emergency change created:** ${md(c.change!.number, c.change!.web_url)} promotes ${c.fix_mr ? md(`${c.fix_mr.project}!${c.fix_mr.iid}`, c.fix_mr.web_url) : 'the fix'} to production.`,
      `${mentions.length ? `${mentions.map((m) => `@${m}`).join(' ')} please` : 'Please'} review it in ServiceNow and edit anything that needs changing. KBR picks it up from there.`,
    ].join('\n'),
    mentions,
    importance: importanceFor(c),
  };
}

/** The change is drafted, not scheduled: a person reviews it and promotes it. */
export function changeForReview(c: Case, mentions: string[]): Message {
  return {
    body: [
      `**Merged. Emergency change drafted for review:** ${md(c.change!.number, c.change!.web_url)} promotes ${c.fix_mr ? md(`${c.fix_mr.project}!${c.fix_mr.iid}`, c.fix_mr.web_url) : 'the fix'} to production.`,
      `${mentions.length ? `${mentions.map((m) => `@${m}`).join(' ')} please` : 'Please'} open it in ServiceNow, check or edit the details, and click **Promote now**. Nothing goes to production until you do.`,
    ].join('\n'),
    mentions,
    importance: importanceFor(c),
  };
}

export function promoted(c: Case): Message {
  return {
    body: `**KBR promoted ${c.change ? md(c.change.number, c.change.web_url) : 'the fix'} to production** at ${hhmm(c.change?.deployed_at)}. Watching the error rate to confirm recovery.`,
    mentions: [],
    importance: 'normal',
  };
}

export function recovered(
  _c: Case,
  before: number,
  after: number,
  logsUrl: string | null,
): Message {
  return {
    body: `**Recovered.** Errors on the affected apps went from ${before.toFixed(1)}/min to ${after.toFixed(1)}/min after the deploy and stayed there${logsUrl ? ` (${md('logs', logsUrl)})` : ''}.`,
    mentions: [],
    importance: 'normal',
  };
}

export function notRecovered(_c: Case, after: number, logsUrl: string | null): Message {
  return {
    body: `**Not recovered yet:** still ${after.toFixed(1)} errors/min after the deploy${logsUrl ? ` (${md('logs', logsUrl)})` : ''}. Re-checking the root cause.`,
    mentions: [],
    importance: 'high',
  };
}

/** The closing message: what was resolved and the paperwork that now exists. */
export function resolutionDrafted(c: Case, autoResolved: boolean): Message {
  const inc = c.incident ? md(c.incident.number, c.incident.web_url) : 'the incident';
  const restore = duration(
    Date.parse(c.verification?.healthy_since ?? c.milestones.verifying ?? c.updated_at) -
      Date.parse(c.scope?.onset ?? c.opened_at),
  );
  const lines = [
    autoResolved
      ? `**Resolved** ${inc}. Time to restore: ${restore}.`
      : `**Resolution drafted** on ${inc}. Please review the close notes and resolve it.`,
    '',
    `- **Incident record:** the Resolution section is filled in${c.resolution?.fields.cause_code ? ` (cause code ${c.resolution.fields.cause_code}${c.resolution.fields.caused_by_change ? `, caused by ${c.resolution.fields.caused_by_change}` : ''}${c.resolution.fields.resolved_by_change ? `, fixed by ${c.resolution.fields.resolved_by_change}` : ''})` : ''}.`,
  ];
  if (c.children.length)
    lines.push(
      `- **Caller tickets:** ${c.children.length} grouped under it ${autoResolved ? 'were resolved with the same resolution' : 'will be resolved with it'}.`,
    );
  if (c.problem)
    lines.push(
      `- **Problem record:** ${md(c.problem.number, c.problem.web_url)} is on the agenda for the 8:00 AM problem stand-up${c.problem.standup_date ? ` on ${c.problem.standup_date}` : ''}. This chat now carries its number.`,
    );
  const comm = c.communications.find((x) => x.kind === 'restored');
  if (comm)
    lines.push(
      `- **Communication:** the RESTORED Critical Incident Communication ${md(comm.number, comm.web_url)} is drafted for ${comm.to || 'the distribution group'}${comm.specialist ? `; @${comm.specialist} please review and send` : ''}.`,
    );
  if (c.meeting) lines.push('- **Call:** ended; the recording and transcript are in this chat.');
  return {
    body: lines.join('\n'),
    mentions: comm?.specialist ? [comm.specialist] : [],
    importance: 'normal',
  };
}

/** Tells the channel a communication draft is waiting for a person to send. */
export function communicationDrafted(comm: Case['communications'][number]): Message {
  return {
    body: `**Critical Incident Communication drafted:** ${md(comm.subject || comm.number, comm.web_url)} for ${comm.to || 'the distribution group'}. ${comm.specialist ? `@${comm.specialist} please` : 'Communication Specialist: please'} review and send it from ServiceNow; I only draft.`,
    mentions: comm.specialist ? [comm.specialist] : [],
    importance: 'normal',
  };
}

export function callersGrouped(
  c: Case,
  added: { number: string; location: string | null }[],
): Message {
  const places = [...new Set(added.map((a) => a.location).filter(Boolean))];
  return {
    body: `**Grouped ${added.length} call${added.length === 1 ? '' : 's'}** under ${c.incident ? md(c.incident.number, c.incident.web_url) : 'the incident'}${places.length ? ` from ${places.join(', ')}` : ''}: ${added.map((a) => a.number).join(', ')}. Callers will get the updates and the resolution.`,
    mentions: [],
    importance: 'normal',
  };
}

export function failure(c: Case, reason: string): Message {
  return {
    body: `⚠️ **Automation stopped on this incident:** ${reason}\nPlease take over from here; everything I found is on ${c.incident ? md(c.incident.number, c.incident.web_url) : 'the case'}.`,
    mentions: [],
    importance: 'high',
  };
}
