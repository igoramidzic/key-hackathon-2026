/**
 * People and the incident channel (#19). One problem gets one channel with one representative per
 * affected team plus the upstream team we suspect, not one channel per app or everyone from every
 * support group. Everyone gets a reason that says why they are there.
 */
import { ensureOnce } from '../actions/ensure';
import type { Case } from '../cases/types';
import { McpToolError } from '../mcp/gateway';
import { errorMessage, hhmm, slugify } from '../util';
import { addLinks, workNote } from './incident';
import { failingApps, username } from './rca';
import type { FlowDeps } from './steps';

export interface Invite {
  user: string;
  reason: string;
  role: 'owner' | 'member';
  /** What brought them in (for ordering and later diffs). */
  kind: 'commander' | 'mim' | 'suspect' | 'author' | 'affected' | 'service_desk' | 'other';
  priority: number;
}

interface GroupRow {
  id: string;
  name: string;
  type?: string;
  on_call?: { primary?: { username: string }; secondary?: { username: string } };
}

const groupCache = new Map<string, GroupRow | null>();

async function sharedGroup(deps: FlowDeps, type: string, id: string): Promise<GroupRow | null> {
  const key = `${type}/${id}`;
  if (groupCache.has(key)) return groupCache.get(key) ?? null;
  let row: GroupRow | null = null;
  try {
    const res = await deps.mcp.call<{ items: GroupRow[] }>(
      'search_support_groups',
      { type, limit: 10 },
      { quiet: true },
    );
    row = res.items.find((g) => g.id === id) ?? res.items[0] ?? null;
  } catch (err) {
    deps.log.warn(`search_support_groups ${type}: ${errorMessage(err)}`);
  }
  groupCache.set(key, row);
  return row;
}

/** P1 = 1/1, P2 = 1/2 or 2/1 (ServiceNow's derivation). */
export function priorityOf(impact: number, urgency: number): number {
  const sum = impact + urgency;
  return sum <= 2 ? 1 : sum === 3 ? 2 : sum === 4 ? 3 : sum === 5 ? 4 : 5;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The top upstream suspect: shared by every failing app, or the confident RCA culprit. */
export function upstreamSuspect(deps: FlowDeps, c: Case): { tla: string; why: string } | null {
  const rc = c.root_cause;
  if (rc && rc.confidence >= deps.config.rcaConfidence)
    return { tla: rc.culprit_tla, why: 'root cause analysis points at its recent change' };
  const quick = c.suspects[0];
  if (quick && quick.confidence >= deps.config.rcaConfidence)
    return {
      tla: quick.tla,
      why: `its change ${quick.change_request?.number ?? ''} is the top suspect`,
    };
  const shared = c.upstream_candidates.find((u) => u.covers === u.of && u.of > 1 && !u.failing);
  if (shared) return { tla: shared.tla, why: 'every failing app depends on it' };
  return null;
}

/** Everyone who should be in the channel right now, deduped, in priority order. */
export async function desiredInvites(deps: FlowDeps, c: Case): Promise<Invite[]> {
  const graph = deps.graph();
  const invites: Invite[] = [];
  const add = (inv: Invite) => {
    const existing = invites.find((i) => i.user === inv.user);
    if (existing) {
      if (!existing.reason.includes(inv.reason))
        existing.reason = `${existing.reason}; ${inv.reason}`.slice(0, 300);
      existing.priority = Math.min(existing.priority, inv.priority);
      return;
    }
    invites.push(inv);
  };

  const noc = await sharedGroup(deps, 'noc', 'grp_noc');
  add({
    user: noc?.on_call?.primary?.username ?? deps.config.fallback.commander,
    reason: 'incident commander (NOC on-call)',
    role: 'owner',
    kind: 'commander',
    priority: 0,
  });

  const impact = c.scope?.suggested_impact ?? 3;
  const urgency = c.scope?.suggested_urgency ?? 3;
  if (priorityOf(impact, urgency) <= 2) {
    const mim = await sharedGroup(deps, 'incident_management', 'grp_mim');
    add({
      user: mim?.on_call?.primary?.username ?? deps.config.fallback.mim,
      reason: `major incident manager (P${priorityOf(impact, urgency)})`,
      role: 'member',
      kind: 'mim',
      priority: 1,
    });
  }

  // Upstream suspect: primary + secondary of its support group.
  const suspect = upstreamSuspect(deps, c);
  const failing = failingApps(c);
  if (suspect && !failing.includes(suspect.tla)) {
    const node = graph.nodes.get(suspect.tla);
    const callers = failing.filter((a) => graph.upstreamOf(a, 3).has(suspect.tla));
    const reason = `on-call for ${suspect.tla}: no errors there, but ${list(callers.slice(0, 3))}${callers.length > 3 ? ` and ${callers.length - 3} more` : ''} depend on it (${suspect.why}). Please check its recent changes`;
    if (node?.on_call?.primary)
      add({ user: node.on_call.primary, reason, role: 'member', kind: 'suspect', priority: 2 });
    if (node?.on_call?.secondary)
      add({
        user: node.on_call.secondary,
        reason: `backup on-call for ${suspect.tla} (suspected upstream)`,
        role: 'member',
        kind: 'suspect',
        priority: 6,
      });
  }

  // The author and approvers of the suspected MR.
  const mrRef =
    c.root_cause?.merge_request ??
    (c.suspects[0] && c.suspects[0].confidence >= deps.config.rcaConfidence
      ? c.suspects[0].merge_request
      : null);
  if (mrRef) {
    try {
      const mr = await deps.mcp.call<{
        author: string | { username: string };
        approved_by?: (string | { username: string })[];
      }>(
        'get_merge_request',
        { project: mrRef.project, iid: mrRef.iid },
        { caseId: c.id, quiet: true },
      );
      const author = username(mr.author);
      if (author && author !== deps.config.identity)
        add({
          user: author,
          reason: `author of ${mrRef.project}!${mrRef.iid} (suspected change)`,
          role: 'member',
          kind: 'author',
          priority: 3,
        });
      for (const a of mr.approved_by ?? []) {
        const u = username(a);
        if (u)
          add({
            user: u,
            reason: `approved ${mrRef.project}!${mrRef.iid} (suspected change)`,
            role: 'member',
            kind: 'author',
            priority: 7,
          });
      }
    } catch (err) {
      deps.log.debug(`get_merge_request for invites: ${errorMessage(err)}`);
    }
  }

  // One rep per affected team, naming every app of theirs that is failing.
  const byGroup = new Map<string, { primary: string | null; apps: string[] }>();
  const affected = (c.scope?.affected_apps ?? []).filter((a) => failing.includes(a.tla));
  const order = affected.length ? affected.map((a) => a.tla) : failing;
  for (const tla of order) {
    const node = graph.nodes.get(tla);
    const gid = node?.support_group?.id ?? `none:${tla}`;
    const entry = byGroup.get(gid) ?? { primary: node?.on_call?.primary ?? null, apps: [] };
    entry.apps.push(tla);
    byGroup.set(gid, entry);
  }
  let rank = 0;
  for (const { primary, apps } of byGroup.values()) {
    if (!primary) continue;
    const since = affected
      .filter((a) => apps.includes(a.tla))
      .map((a) => a.onset)
      .sort()[0];
    add({
      user: primary,
      reason:
        `on-call for ${list(apps.slice(0, 3))}${apps.length > 3 ? ` and ${apps.length - 3} more` : ''} (${apps.length > 1 ? 'all' : ''} failing since ${hhmm(since ?? c.onset_at)})`.replace(
          '( ',
          '(',
        ),
      role: 'member',
      kind: 'affected',
      priority: 4 + rank++ / 100,
    });
  }

  // The service desk once callers are grouped under the incident (#25).
  if (c.children.length) {
    const sd = await sharedGroup(deps, 'service_desk', 'grp_service_desk');
    add({
      user: sd?.on_call?.primary?.username ?? deps.config.fallback.serviceDesk,
      reason: `service desk on-call (${c.children.length} staff calls grouped under the incident)`,
      role: 'member',
      kind: 'service_desk',
      priority: 5,
    });
  }

  return invites
    .filter((i) => i.user !== deps.config.identity)
    .sort((a, b) => a.priority - b.priority);
}

export function channelName(incidentNumber: string, summary: string): string {
  const prefix = `${incidentNumber.toLowerCase()}-`;
  const slug = slugify(summary, 50 - prefix.length) || 'incident';
  return `${prefix}${slug}`.slice(0, 50).replace(/-+$/, '');
}

interface ChannelRecord {
  id: string;
  name: string;
  web_url: string;
  members?: { username: string }[];
}

/** Creates (or reuses) the incident channel with the first ~8 people. */
export async function assembleChannel(
  deps: FlowDeps,
  c: Case,
): Promise<'existing' | 'found' | 'created'> {
  if (!c.incident) throw new Error('no incident to assemble a channel for');
  const invites = await desiredInvites(deps, c);
  const first = invites.slice(0, deps.config.maxInvites);
  const name = channelName(c.incident.number, c.scope?.summary ?? c.apps.join(' '));
  const prio = priorityOf(c.scope?.suggested_impact ?? 3, c.scope?.suggested_urgency ?? 3);
  const lookup = async () => {
    try {
      const ch = await deps.mcp.call<ChannelRecord>(
        'get_channel',
        { channel: name },
        { caseId: c.id },
      );
      return { id: ch.id, name: ch.name, web_url: ch.web_url };
    } catch (err) {
      if (err instanceof McpToolError && err.notFound) return null;
      throw err;
    }
  };
  const { how } = await ensureOnce({
    current: () => c.channel,
    lookup,
    create: async () => {
      try {
        const ch = await deps.mcp.call<ChannelRecord>(
          'create_channel',
          {
            name,
            display_name: `${c.incident!.number} ${c.scope?.summary ?? ''}`.slice(0, 80),
            description:
              `P${prio} ${c.incident!.app_tla ? deps.graph().label(c.incident!.app_tla) : ''}: ${c.scope?.summary ?? ''} since ${hhmm(c.scope?.onset ?? c.onset_at)}. ServiceNow ${c.incident!.number}.`.slice(
                0,
                300,
              ),
            members: first.map((i) => ({ user: i.user, reason: i.reason, role: i.role })),
          },
          { caseId: c.id },
        );
        return { id: ch.id, name: ch.name, web_url: ch.web_url };
      } catch (err) {
        if (err instanceof McpToolError && err.conflict) {
          const found = await lookup();
          if (found) return found;
        }
        throw err;
      }
    },
    record: (value, how) => {
      c.channel = value;
      if (how === 'created')
        c.members = first.map((i) => ({ username: i.user, reason: i.reason, role: i.role }));
      deps.store.save(c);
    },
  });
  if (how !== 'created') await syncMembers(deps, c, { refresh: true });
  deps.store.event(
    c,
    'action',
    `${how === 'created' ? 'Opened' : 'Reusing'} #${c.channel!.name} with ${c.members.length} people: ${c.members.map((m) => m.username).join(', ')}`,
    { url: c.channel!.web_url },
  );
  await addLinks(
    deps,
    c,
    [{ type: 'teams_channel', url: c.channel!.web_url, title: `Teams #${c.channel!.name}` }],
    `Incident channel #${c.channel!.name} opened: ${c.channel!.web_url}. Invited ${c.members.map((m) => `${m.username} (${m.reason})`).join('; ')}.`,
  );
  return how;
}

/**
 * Adds anyone who should be in the channel and isn't (an app joined, RCA moved to another
 * upstream, callers were grouped). Never removes people automatically. Returns who was added.
 */
export async function syncMembers(
  deps: FlowDeps,
  c: Case,
  opts: { refresh?: boolean; extra?: Invite[] } = {},
): Promise<Invite[]> {
  if (!c.channel) return [];
  if (opts.refresh) {
    try {
      const ch = await deps.mcp.call<ChannelRecord>(
        'get_channel',
        { channel: c.channel.id },
        { caseId: c.id, quiet: true },
      );
      for (const m of ch.members ?? [])
        if (!c.members.some((x) => x.username === m.username))
          c.members.push({
            username: m.username,
            reason: 'already in the channel',
            role: 'member',
          });
    } catch {
      // keep what we know
    }
  }
  const desired = [...(await desiredInvites(deps, c)), ...(opts.extra ?? [])];
  const have = new Set(c.members.map((m) => m.username));
  // Beyond the first invite cap, only people for apps/teams that joined later are added.
  const missing = desired.filter((i) => !have.has(i.user));
  const cap = Math.max(0, deps.config.maxInvites + 6 - c.members.length);
  const toAdd = missing
    .filter((i) => i.kind !== 'affected' || cap > 0)
    .slice(0, Math.max(cap, missing.filter((i) => i.kind !== 'affected').length));
  if (!toAdd.length) return [];
  const added: Invite[] = [];
  try {
    await deps.mcp.call(
      'add_channel_members',
      {
        channel: c.channel.id,
        members: toAdd.map((i) => ({ user: i.user, reason: i.reason, role: i.role })),
      },
      { caseId: c.id },
    );
    added.push(...toAdd);
  } catch (err) {
    // An unknown user must not block everyone else: add them one by one.
    if (!(err instanceof McpToolError)) throw err;
    for (const i of toAdd) {
      try {
        await deps.mcp.call(
          'add_channel_members',
          { channel: c.channel.id, members: [{ user: i.user, reason: i.reason, role: i.role }] },
          { caseId: c.id },
        );
        added.push(i);
      } catch (e) {
        deps.store.event(c, 'error', `Could not add ${i.user}: ${errorMessage(e)}`);
      }
    }
  }
  for (const i of added) c.members.push({ username: i.user, reason: i.reason, role: i.role });
  if (added.length) {
    deps.store.event(
      c,
      'action',
      `Added ${added.map((i) => `${i.user} (${i.reason})`).join('; ')} to #${c.channel.name}`,
      { url: c.channel.web_url },
    );
    await workNote(
      deps,
      c,
      `Added to #${c.channel.name}: ${added.map((i) => `${i.user} (${i.reason})`).join('; ')}`,
    );
  }
  return added;
}

/** Groups we could not invite yet (cap), for the briefing. */
export async function notInvited(deps: FlowDeps, c: Case): Promise<Invite[]> {
  const have = new Set(c.members.map((m) => m.username));
  return (await desiredInvites(deps, c)).filter((i) => !have.has(i.user));
}
