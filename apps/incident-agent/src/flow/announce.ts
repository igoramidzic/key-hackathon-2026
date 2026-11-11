/**
 * Posting to the incident channel (#20). Each update has a key and is posted once. Updates are
 * coalesced (at most one message per ~30s per channel) and mirrored as incident work notes.
 */
import type { Case } from '../cases/types';
import type { Message } from '../messages/teams';
import { errorMessage, isoNow } from '../util';
import { workNote } from './incident';
import type { FlowDeps } from './steps';

const RANK = { normal: 0, high: 1, urgent: 2 } as const;
const announced = (c: Case, key: string) => Boolean(c.milestones[`announce:${key}`]);

export function windowMs(deps: FlowDeps): number {
  return Math.max(5_000, 30_000 / deps.config.speed);
}

/** Queues an update for the next flush. Returns false when it was already posted or queued. */
export function queue(
  deps: FlowDeps,
  c: Case,
  key: string,
  msg: Message,
  note?: string | null,
): boolean {
  if (announced(c, key) || c.outbox.some((o) => o.key === key)) return false;
  c.outbox.push({
    key,
    body: msg.body,
    mentions: msg.mentions,
    importance: msg.importance,
    work_note: note ?? null,
    at: isoNow(),
  });
  deps.store.save(c);
  return true;
}

async function post(
  deps: FlowDeps,
  c: Case,
  body: string,
  mentions: string[],
  importance: Message['importance'],
): Promise<string | null> {
  if (!c.channel) return null;
  const res = await deps.mcp.call<{ id?: string; web_url?: string }>(
    'post_message',
    { channel: c.channel.id, body, mentions: [...new Set(mentions)], importance },
    { caseId: c.id },
  );
  c.last_post_at = isoNow();
  return res.web_url ?? null;
}

/** Posts right away (the briefing, failures), bypassing the coalescing window. */
export async function postNow(
  deps: FlowDeps,
  c: Case,
  key: string,
  msg: Message,
  note?: string | null,
): Promise<boolean> {
  if (announced(c, key)) return false;
  const url = await post(deps, c, msg.body, msg.mentions, msg.importance);
  c.milestones[`announce:${key}`] = isoNow();
  deps.store.event(c, 'message', `Posted ${key} in #${c.channel?.name ?? '(no channel)'}`, {
    url: url ?? c.channel?.web_url,
  });
  if (note !== null)
    await workNote(deps, c, note ?? `Posted in Teams #${c.channel?.name}:\n\n${msg.body}`);
  deps.store.save(c);
  return true;
}

/** Posts everything queued as one message once the window allows (or `force`). */
export async function flush(deps: FlowDeps, c: Case, force = false): Promise<number> {
  if (c.outbox.length === 0) return 0;
  if (!force && c.last_post_at && Date.now() - Date.parse(c.last_post_at) < windowMs(deps))
    return 0;
  const items = [...c.outbox];
  const body = items.map((i) => i.body).join('\n\n---\n\n');
  const mentions = items.flatMap((i) => i.mentions);
  const importance = items.reduce<Message['importance']>(
    (a, i) => (RANK[i.importance] > RANK[a] ? i.importance : a),
    'normal',
  );
  try {
    const url = await post(deps, c, body, mentions, importance);
    deps.store.event(c, 'message', `Posted ${items.map((i) => i.key).join(', ')}`, {
      url: url ?? c.channel?.web_url,
    });
  } catch (err) {
    deps.log.warn(`${c.id} post failed: ${errorMessage(err)}`);
    throw err;
  }
  for (const i of items) c.milestones[`announce:${i.key}`] = isoNow();
  c.outbox = c.outbox.filter((o) => !items.includes(o));
  deps.store.save(c);
  const notes = items.map((i) => i.work_note ?? i.body).join('\n\n');
  await workNote(
    deps,
    c,
    c.channel ? `Update posted in Teams #${c.channel.name}:\n\n${notes}` : notes,
  );
  return items.length;
}

export const wasAnnounced = announced;
