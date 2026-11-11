/**
 * Two-way channel (#21). The agent reads what humans write in the incident channel and reacts:
 *   question    → answers in a thread, with links from the tools
 *   correction  → re-runs the deep RCA with the hint and posts what it finds
 *   ownership   → work note, and assigns the incident to whoever takes it
 *   merged      → checks the fix MR right away
 *   regroup     → "<TLA> is unrelated" / "same as INC…" (#29 acts on it)
 *   destructive → never does it; says what the human has to click instead
 */
import { z } from 'zod';
import type { StepContext } from '../cases/orchestrator';
import type { Case } from '../cases/types';
import { errorMessage, hhmm, isoNow } from '../util';
import { workNote } from './incident';
import type { ChangeSummary, MrDetail } from './rca';
import type { FlowDeps } from './steps';

export interface ChatMessage {
  id: string;
  author: string;
  author_name?: string;
  kind?: string;
  created_at: string;
  body: string;
  reply_to_id?: string;
}

export type Intent =
  | 'question'
  | 'correction'
  | 'ownership'
  | 'merged'
  | 'regroup'
  | 'destructive'
  | 'other';

export interface Classified {
  intent: Intent;
  /** A TLA the message is about (e.g. "CIF is unrelated", "what changed in CIF"). */
  tla?: string;
  /** An incident number the message points at ("same as INC0010205"). */
  incident?: string;
  /** For regroup: split an app out, or merge with another incident. */
  regroup?: 'split' | 'merge';
  hours?: number;
}

/** Deterministic intent classification (the LLM refines it when available). */
export function classify(text: string, knownTlas: Set<string>): Classified {
  const t = text.trim();
  const lower = t.toLowerCase();
  const tla = [...t.matchAll(/\b([A-Z]{3})\b/g)].map((m) => m[1]!).find((x) => knownTlas.has(x));
  const incident = t.match(/\bINC\d{7}\b/i)?.[0].toUpperCase();
  const hours = Number(
    lower.match(/last\s+(\d+)\s*h/)?.[1] ?? lower.match(/(\d+)\s*hours?/)?.[1] ?? Number.NaN,
  );

  if (
    /\b(delete|drop|wipe|force[- ]?push|close (the|this) incident|merge (it|the mr|the fix|that)( for me)?|can you merge|please merge|you merge|roll ?back prod|deploy it yourself)\b/.test(
      lower,
    )
  )
    return { intent: 'destructive', tla };
  if (
    /\b(i('ve| have)? merged|merged( it| the (mr|fix))?|clicked merge|merge done|it'?s merged)\b/.test(
      lower,
    ) &&
    !/not merged|hasn'?t been merged/.test(lower)
  )
    return { intent: 'merged' };
  if (incident && /\b(same (as|issue|problem)|duplicate|related to|part of)\b/.test(lower))
    return { intent: 'regroup', regroup: 'merge', incident };
  if (
    tla &&
    /\b(unrelated|not related|separate (issue|problem)|different (issue|problem)|split)\b/.test(
      lower,
    )
  )
    return { intent: 'regroup', regroup: 'split', tla };
  if (
    /\b(i'?ll take|i will take|taking (this|it|lead)|i'?m on it|on it\b|i own|assign (it )?to me|ack(nowledged)?\b|looking into it)\b/.test(
      lower,
    )
  )
    return { intent: 'ownership' };
  if (
    /\b(not (that|this|the) (mr|change|deploy|chg)|wrong (mr|change)|it'?s not|isn'?t (it|the cause)|look at|check (the )?(other|\w+'s)|try|actually|i think it'?s|probably (the|a))\b/.test(
      lower,
    )
  )
    return { intent: 'correction', tla };
  if (
    t.endsWith('?') ||
    /^(what|why|when|who|how|which|where|can|could|is|are|did|do|does|any)\b/.test(lower)
  )
    return { intent: 'question', tla, hours: Number.isFinite(hours) ? hours : undefined };
  return { intent: 'other', tla };
}

const md = (label: string, url: string | null | undefined) => (url ? `[${label}](${url})` : label);

/** "what changed in <TLA> in the last 6h?" — promoted changes and merged MRs, with links. */
export async function whatChanged(
  deps: FlowDeps,
  c: Case,
  tla: string,
  hours = 6,
): Promise<string> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const [changes, mrs] = await Promise.all([
    deps.mcp.call<{ items: ChangeSummary[] }>(
      'list_change_requests',
      { app_tla: tla, implemented_after: since, limit: 10 },
      { caseId: c.id },
    ),
    deps.mcp.call<{ items: MrDetail[] }>(
      'list_merge_requests',
      { tla, state: 'merged', merged_after: since, limit: 10 },
      { caseId: c.id },
    ),
  ]);
  const lines = [`**${deps.graph().label(tla)}, last ${hours}h:**`];
  if (changes.items.length) {
    lines.push('Promoted to production:');
    for (const ch of changes.items)
      lines.push(
        `- ${md(ch.number, ch.web_url)} at ${hhmm(ch.implemented_at)}: ${ch.short_description}`,
      );
  } else lines.push('Nothing promoted to production.');
  const promoted = new Set(changes.items.map((ch) => ch.short_description));
  const qvOnly = mrs.items.filter((m) => ![...promoted].some((d) => d.includes(m.title)));
  if (qvOnly.length) {
    lines.push('Merged to main (QV only unless a change above promoted it):');
    for (const m of qvOnly)
      lines.push(
        `- ${md(`${m.project}!${m.iid}`, m.web_url)} "${m.title}" merged ${hhmm(m.merged_at)}`,
      );
  }
  return lines.join('\n');
}

/** Where things stand, with links. */
export function statusAnswer(c: Case): string {
  const lines = [`**Status:** ${c.phase.replace(/_/g, ' ')}.`];
  if (c.root_cause)
    lines.push(
      `Root cause (${Math.round(c.root_cause.confidence * 100)}%): ${c.root_cause.culprit_tla} ${md(c.root_cause.change_request?.number ?? 'change', c.root_cause.change_request?.web_url)}: ${c.root_cause.mechanism}`,
    );
  else if (c.suspects[0])
    lines.push(
      `Top suspect: ${c.suspects[0].tla} ${md(c.suspects[0].change_request?.number ?? '', c.suspects[0].change_request?.web_url)} (confirming).`,
    );
  if (c.fix_mr)
    lines.push(
      `Fix: ${md(`${c.fix_mr.project}!${c.fix_mr.iid}`, c.fix_mr.web_url)} (${c.fix_mr.state}).`,
    );
  if (c.change) lines.push(`Change: ${md(c.change.number, c.change.web_url)} (${c.change.state}).`);
  if (c.incident) lines.push(`Incident: ${md(c.incident.number, c.incident.web_url)}.`);
  return lines.join('\n');
}

const Answer = z.object({
  answer: z.string(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
});

async function answerQuestion(
  deps: FlowDeps,
  c: Case,
  msg: ChatMessage,
  cls: Classified,
): Promise<string> {
  const deterministic = () =>
    cls.tla && /\b(change|changed|deploy|deployed|merged|release|promot)/i.test(msg.body)
      ? whatChanged(deps, c, cls.tla, cls.hours ?? 6)
      : Promise.resolve(statusAnswer(c));
  if (!deps.runner) return deterministic();
  const out = await deps.runner.run({
    name: 'chat',
    caseId: c.id,
    system:
      'You answer questions from engineers in an incident channel at a bank. You are read-only. Be brief and specific. Only include links that appeared in tool results or in the case context.',
    prompt: `Case context:\n${statusAnswer(c)}\nScope: ${JSON.stringify(c.scope?.affected_apps.slice(0, 10) ?? [])}\n\nQuestion from @${msg.author}: ${msg.body}`,
    tools: [
      'search_logs',
      'summarize_errors',
      'list_change_requests',
      'get_change_request',
      'list_merge_requests',
      'get_merge_request',
      'get_app',
      'get_app_dependencies',
      'list_incidents',
    ],
    schema: Answer,
    maxTurns: 10,
    timeoutMs: 60_000,
  });
  if (!out.ok) return deterministic();
  const bases = Object.values(deps.config.web);
  const links = out.value.links.filter((l) => bases.some((b) => l.url.startsWith(b)));
  return [out.value.answer, ...links.map((l) => `- ${md(l.label, l.url)}`)].join('\n');
}

export interface ChatHooks {
  /** Re-run the deep RCA with a human hint. */
  rerunRca(c: Case, hint: string): void;
  /** Check the fix MR now. */
  checkMerge(c: Case): void;
  /** Split an app out of the case or merge with another incident (#29). */
  regroup(
    c: Case,
    request: { kind: 'split' | 'merge'; tla?: string; incident?: string; by: string; text: string },
  ): Promise<string>;
}

async function reply(deps: FlowDeps, c: Case, to: ChatMessage, body: string): Promise<void> {
  await deps.mcp.call(
    'post_message',
    { channel: c.channel!.id, body, reply_to_id: to.id },
    { caseId: c.id },
  );
}

/** Handles one human message. Returns the intent (for the timeline and tests). */
const Classification = z.object({
  intent: z.enum([
    'question',
    'correction',
    'ownership',
    'merged',
    'regroup',
    'destructive',
    'other',
  ]),
  tla: z.string().nullable().default(null),
  incident: z.string().nullable().default(null),
  regroup: z.enum(['split', 'merge']).nullable().default(null),
  hours: z.number().nullable().default(null),
});

/** The AI classifies (small call, no tools); the regex classifier is the fallback. */
async function classifyMessage(deps: FlowDeps, c: Case, msg: ChatMessage): Promise<Classified> {
  const known = new Set(deps.graph().nodes.keys());
  const fallback = classify(msg.body, known);
  if (!deps.runner) return fallback;
  const out = await deps.runner.run({
    name: 'chat_classify',
    caseId: c.id,
    system:
      'Classify one message an engineer wrote in an incident channel. intent: question (wants information), correction (pushes back on the root cause or hints at another cause), ownership (takes or acknowledges ownership), merged (says the fix MR was merged or approved), regroup (says an app is unrelated -> regroup "split" with tla, or that this is the same as another incident -> regroup "merge" with incident), destructive (asks the agent to merge, delete, close or roll back something itself), other. tla is a 3-letter application code if the message is about one; incident an INC number if mentioned; hours a time window if asked. Answer with JSON only.',
    prompt: `Apps in this incident: ${c.apps.slice(0, 20).join(', ')}.\nMessage from @${msg.author}: ${msg.body}`,
    tools: [],
    schema: Classification,
    maxTurns: 2,
    timeoutMs: 30_000,
  });
  if (!out.ok) return fallback;
  const v = out.value;
  const tla = v.tla?.toUpperCase();
  return {
    intent: v.intent,
    tla: tla && known.has(tla) ? tla : fallback.tla,
    incident: v.incident ?? fallback.incident,
    regroup: v.regroup ?? fallback.regroup,
    hours: v.hours ?? fallback.hours,
  };
}

export async function handleMessage(
  deps: FlowDeps,
  c: Case,
  msg: ChatMessage,
  hooks: ChatHooks,
): Promise<Intent> {
  const cls = await classifyMessage(deps, c, msg);
  deps.store.event(
    c,
    'note',
    `@${msg.author} in #${c.channel?.name}: "${msg.body.slice(0, 160)}" → ${cls.intent}`,
    { data: { message: msg.id, ...cls } },
  );
  switch (cls.intent) {
    case 'destructive': {
      const mr = c.fix_mr
        ? ` The fix is ${md(`${c.fix_mr.project}!${c.fix_mr.iid}`, c.fix_mr.web_url)}: please review it and click **Merge** in GitLab.`
        : '';
      await reply(
        deps,
        c,
        msg,
        `I can't merge, delete or close things myself: a human makes those calls.${mr} Once it's merged I raise the emergency change and KBR promotes it.`,
      );
      break;
    }
    case 'merged':
      hooks.checkMerge(c);
      await reply(
        deps,
        c,
        msg,
        `Thanks @${msg.author}, checking ${c.fix_mr ? md(`${c.fix_mr.project}!${c.fix_mr.iid}`, c.fix_mr.web_url) : 'the MR'} now; I'll raise the emergency change as soon as GitLab shows it merged.`,
      );
      break;
    case 'ownership': {
      if (c.incident) {
        try {
          await deps.mcp.call(
            'update_incident',
            {
              number: c.incident.number,
              assigned_to: msg.author,
              work_note: `@${msg.author} took ownership in Teams: "${msg.body}"`,
            },
            { caseId: c.id },
          );
          await reply(
            deps,
            c,
            msg,
            `Thanks @${msg.author}, ${md(c.incident.number, c.incident.web_url)} is assigned to you. I'll keep posting updates here.`,
          );
        } catch (err) {
          await workNote(deps, c, `@${msg.author} in Teams: "${msg.body}"`);
          deps.log.warn(`${c.id} assign failed: ${errorMessage(err)}`);
        }
      }
      break;
    }
    case 'correction':
      hooks.rerunRca(c, msg.body);
      await workNote(
        deps,
        c,
        `@${msg.author} suggested in Teams: "${msg.body}". Re-running the root cause analysis with that hint.`,
      );
      await reply(
        deps,
        c,
        msg,
        `Good call @${msg.author}, re-checking the root cause with that in mind. I'll post what I find and update the incident if the culprit changes.`,
      );
      break;
    case 'regroup': {
      const outcome = await hooks.regroup(c, {
        kind: cls.regroup!,
        tla: cls.tla,
        incident: cls.incident,
        by: msg.author,
        text: msg.body,
      });
      await reply(deps, c, msg, outcome);
      break;
    }
    case 'question':
      await reply(deps, c, msg, await answerQuestion(deps, c, msg, cls));
      break;
    default:
      break;
  }
  return cls.intent;
}

/** Reads new human messages in the channel and handles them. */
export async function pollChat(deps: FlowDeps, c: Case, hooks: ChatHooks): Promise<number> {
  if (!c.channel) return 0;
  const since =
    c.chat_cursor ?? c.milestones['announce:briefing'] ?? c.milestones.assembled ?? isoNow();
  const res = await deps.mcp.call<{ items: ChatMessage[] }>(
    'read_messages',
    { channel: c.channel.id, since, limit: 50 },
    { caseId: c.id, quiet: true },
  );
  const items = [...(res.items ?? [])].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  let handled = 0;
  for (const msg of items) {
    c.chat_cursor = msg.id;
    if (msg.author === deps.config.identity || (msg.kind && msg.kind !== 'message')) continue;
    try {
      await handleMessage(deps, c, msg, hooks);
      handled++;
    } catch (err) {
      deps.store.event(
        c,
        'error',
        `Could not handle @${msg.author}'s message: ${errorMessage(err)}`,
      );
    }
  }
  deps.store.save(c);
  return handled;
}

/** Hooks wired to the flow (deep RCA rerun, merge check). Regroup is filled in by #29. */
export function chatHooks(
  deps: FlowDeps,
  ctx: StepContext,
  rerun: (c: Case, hint: string) => void,
  regroup?: ChatHooks['regroup'],
): ChatHooks {
  return {
    rerunRca: rerun,
    checkMerge: (c) => ctx.poke(c.id),
    regroup:
      regroup ??
      (async (c, r) => {
        deps.store.event(
          c,
          'decision',
          `Regroup requested by @${r.by}: ${r.kind} ${r.tla ?? r.incident ?? ''}`,
        );
        return `Noted @${r.by}. I'll look at ${r.kind === 'split' ? `splitting ${r.tla} out` : `merging with ${r.incident}`}.`;
      }),
  };
}
