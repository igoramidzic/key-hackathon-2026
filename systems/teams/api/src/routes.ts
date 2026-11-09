import {
  badRequest,
  csv,
  pageQuery,
  paginate,
  parseBody,
  parseQuery,
  parseTime,
} from '@sim/api-kit';
import type { ResetResult } from '@sim/contracts';
import type {
  ChannelCreated,
  MarkReadResult,
  MessagePosted,
  NotificationPage,
} from '@sim/contracts/teams';
import type { Hono } from 'hono';
import { z } from 'zod';
import { seedStore } from './seed';
import { incidentNumberOf, TeamsStore } from './store';
import { findPerson, requirePerson, searchUsers, toTeamsUser } from './users';

export const SERVICE = 'teams-api';

// Built on first use, not at import: Workers forbid timers and freeze the clock in global scope.
let store: TeamsStore;
let built = false;

function buildStore(): TeamsStore {
  const next = new TeamsStore();
  seedStore(next, new Date());
  return next;
}

export const getStore = (): TeamsStore => {
  if (!built) {
    store = buildStore();
    built = true;
    built = true;
  }
  return store;
};

const memberInput = z.object({
  user: z.string().min(1).describe('username or email'),
  reason: z.string().max(500).optional(),
  role: z.enum(['owner', 'member']).optional(),
});

const createChannelBody = z.object({
  team_id: z.string().min(1).optional(),
  name: z.string().min(1).max(200),
  display_name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.enum(['standard', 'private']).optional(),
  members: z.array(memberInput).max(100).optional(),
  created_by: z.string().min(1).optional(),
});

/** Accepts `{members:[…]}`, a bare array, or a single `{user, reason}`. */
const addMembersBody = z.preprocess(
  (raw) => {
    if (Array.isArray(raw)) return { members: raw };
    if (raw && typeof raw === 'object' && 'user' in raw && !('members' in raw)) {
      const { added_by, ...member } = raw as Record<string, unknown>;
      return { members: [member], added_by };
    }
    return raw;
  },
  z.object({
    members: z.array(memberInput).min(1).max(100),
    added_by: z.string().min(1).optional(),
  }),
);

const postMessageBody = z.object({
  author: z.string().min(1).optional(),
  body: z.string().min(1).max(20_000),
  mentions: z.array(z.string().min(1)).max(50).optional(),
  importance: z.enum(['normal', 'high', 'urgent']).optional(),
  reply_to_id: z.string().min(1).optional(),
});

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

export function registerRoutes(app: Hono) {
  app.use('*', async (_c, next) => {
    getStore();
    await next();
  });
  app.post('/admin/reset', (c) => {
    store = buildStore();
    built = true;
    return c.json<ResetResult>({ ok: true, service: SERVICE, reset_at: new Date().toISOString() });
  });

  // ----- teams -----

  app.get('/api/teams', (c) => {
    const q = parseQuery(c, z.object({ q: z.string().optional(), ...pageQuery }));
    const needle = q.q?.toLowerCase();
    const teams = [...store.teams.values()]
      .filter((t) => !needle || `${t.id} ${t.name} ${t.description}`.toLowerCase().includes(needle))
      .map((t) => store.toTeam(t));
    return c.json(paginate(teams, q));
  });

  app.get('/api/teams/:id', (c) =>
    c.json(store.toTeamDetail(store.resolveTeam(c.req.param('id')))),
  );

  // ----- channels -----

  app.get('/api/channels', (c) => {
    const q = parseQuery(
      c,
      z.object({
        q: z.string().optional(),
        team_id: z.string().optional(),
        member: z.string().optional(),
        incident_only: bool,
        ...pageQuery,
      }),
    );
    const team = q.team_id ? store.resolveTeam(q.team_id) : undefined;
    const member = q.member ? requirePerson(q.member) : undefined;
    const needle = q.q?.trim().toLowerCase().replace(/^#/, '');
    const channels = [...store.channels.values()]
      .filter((ch) => !team || ch.team_id === team.id)
      .filter((ch) => !member || ch.members.has(member.username))
      .filter((ch) => !q.incident_only || incidentNumberOf(ch.name))
      .filter(
        (ch) =>
          !needle ||
          `${ch.name} ${ch.display_name} ${ch.description}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => store.lastActivity(b).getTime() - store.lastActivity(a).getTime())
      .map((ch) => store.toSummary(ch));
    return c.json(paginate(channels, q));
  });

  app.post('/api/channels', async (c) => {
    const body = await parseBody(c, createChannelBody);
    const { channel, notifications } = store.createChannel(body);
    return c.json<ChannelCreated>(
      {
        ...store.toChannel(channel),
        notifications: notifications.map((n) => store.toNotification(n)),
      },
      201,
    );
  });

  app.get('/api/channels/:id', (c) =>
    c.json(store.toChannel(store.resolveChannel(c.req.param('id')))),
  );

  app.get('/api/channels/:id/members', (c) =>
    c.json(store.toChannel(store.resolveChannel(c.req.param('id'))).members),
  );

  app.post('/api/channels/:id/members', async (c) => {
    const channel = store.resolveChannel(c.req.param('id'));
    const body = await parseBody(c, addMembersBody);
    const result = store.addMembers(channel, body.members, body.added_by);
    return c.json(store.toAddResult(channel, result));
  });

  app.delete('/api/channels/:id/members/:user', (c) => {
    const channel = store.resolveChannel(c.req.param('id'));
    const removedBy = c.req.query('removed_by') || undefined;
    const member = store.removeMember(channel, c.req.param('user'), removedBy);
    return c.json(store.toRemoveResult(channel, member));
  });

  app.get('/api/channels/:id/messages', (c) => {
    const channel = store.resolveChannel(c.req.param('id'));
    const q = parseQuery(
      c,
      z.object({
        since: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        cursor: z.string().optional(),
      }),
    );
    const messages = q.since?.startsWith('msg_')
      ? store.listMessages(channel, { afterId: q.since })
      : store.listMessages(channel, { afterTime: parseTime(q.since) });
    return c.json(
      paginate(
        messages.map((m) => store.toMessage(m)),
        q,
      ),
    );
  });

  app.post('/api/channels/:id/messages', async (c) => {
    const channel = store.resolveChannel(c.req.param('id'));
    const body = await parseBody(c, postMessageBody);
    const { message, notifications } = store.postMessage(channel, body);
    return c.json<MessagePosted>(
      {
        ...store.toMessage(message),
        notifications: notifications.map((n) => store.toNotification(n)),
      },
      201,
    );
  });

  // ----- users -----

  app.get('/api/users', (c) => {
    const q = parseQuery(c, z.object({ q: z.string().optional(), usernames: csv, ...pageQuery }));
    if (q.usernames) {
      const users = q.usernames
        .map((u) => findPerson(u))
        .filter((p) => p !== undefined)
        .map(toTeamsUser);
      return c.json(paginate(users, q));
    }
    return c.json(paginate(searchUsers(q.q), q));
  });

  app.get('/api/users/:user', (c) => c.json(store.userDetail(requirePerson(c.req.param('user')))));

  app.get('/api/users/:user/notifications', (c) => {
    const person = requirePerson(c.req.param('user'));
    const q = parseQuery(c, z.object({ unread_only: bool, ...pageQuery }));
    const items = store
      .notificationsFor(person.username, q.unread_only)
      .map((n) => store.toNotification(n));
    return c.json<NotificationPage>({
      ...paginate(items, q),
      unread_count: store.unreadCount(person.username),
    });
  });

  app.post('/api/users/:user/notifications/read', async (c) => {
    const person = requirePerson(c.req.param('user'));
    let ids: string[] | undefined;
    const text = await c.req.text();
    if (text.trim()) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw badRequest('Request body must be JSON');
      }
      const parsed = z.object({ ids: z.array(z.string()).optional() }).safeParse(raw);
      if (!parsed.success) throw badRequest('ids must be an array of notification ids');
      ids = parsed.data.ids;
    }
    const marked = store.markRead(person.username, ids);
    return c.json<MarkReadResult>({
      marked_read: marked,
      unread_count: store.unreadCount(person.username),
    });
  });
}
