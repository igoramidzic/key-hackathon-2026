import { URLS } from '@sim/contracts';
import {
  type Channel,
  type ChannelMember,
  createTeamsClient,
  type Message,
  type Notification,
} from '@sim/contracts/teams';
import {
  defineTool,
  IDEMPOTENT_WRITE,
  type McpServerSpec,
  paginationShape,
  READ_ONLY,
  WRITE,
} from '@sim/mcp-kit';
import { z } from 'zod';

export const api = createTeamsClient(process.env.TEAMS_API_URL ?? URLS.teams.api);

const INSTRUCTIONS = `Simulated Microsoft Teams for the bank's IT organisation. Use it to pull people into an incident and keep them updated.

Typical flow:
1. create_channel in the "Incident Response" team (the default) named inc<number>-<short-slug>, e.g. inc0010234-customer-profile-errors (lowercase, hyphens, max 50 chars; the ServiceNow incident number goes first). Add the initial people with a reason each.
2. add_channel_members as you identify more owners (on-call support for the affected app, developers of the suspect repo, DBA/network/NOC). Always give a reason such as "support for CIF - Customer Information File".
3. post_message for findings and status updates (markdown; @username mentions notify people; importance high/urgent for P1/P2).
4. read_messages to see what humans replied (pass since=<last message id> to poll for new ones).

People: users are the same usernames (e.g. dwhitfield) or emails (dana.whitfield@keybank.example) as in ServiceNow and GitLab. Unknown users fail with suggested close matches. Your identity is svc_incident_auto ("Incident Automation"), the default creator/author.

Notifications: every person added to a channel gets an activity notification ("You've been added to #<channel> as <reason>. Here's who else is in the channel: Name (role/reason), ...") plus a system message in the channel. @mentions create "mention" notifications; replies notify the parent author. list_notifications shows a user's activity feed.

Channels are referenced by id (ch_...) or name. Each has a web_url to paste into ServiceNow work notes. There are no delete tools; remove_channel_member takes someone out of a channel.`;

// ---------------------------------------------------------------------------
// Shared input fields
// ---------------------------------------------------------------------------

const channelRef = z
  .string()
  .min(1)
  .describe(
    'Channel id (e.g. "ch_be49f418") or channel name (e.g. "inc0010234-customer-profile-errors"). For names that exist in several teams (like "general"), use "<team id>/<name>".',
  );

const userRef = (what: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${what}: username (e.g. "dwhitfield") or email (e.g. "dana.whitfield@keybank.example"). Same keys as ServiceNow/GitLab.`,
    );

const memberShape = z.object({
  user: userRef('Person to add'),
  reason: z
    .string()
    .max(300)
    .optional()
    .describe(
      'Why they are being added, phrased to follow "as": e.g. "support for CIF - Customer Information File", "CIF on-call", "developer of customer-profile-api (suspect commit)", "DBA on-call". Shown in their notification and the members panel.',
    ),
  role: z
    .enum(['owner', 'member'])
    .optional()
    .describe('Channel role. Default "member"; use "owner" for the incident commander.'),
});

// ---------------------------------------------------------------------------
// Compact views
// ---------------------------------------------------------------------------

const member = (m: ChannelMember) => ({
  username: m.username,
  name: m.name,
  title: m.title,
  role: m.role,
  reason: m.reason,
  presence: m.presence,
  added_by: m.added_by,
  added_at: m.added_at,
});

const channelView = (c: Channel) => ({
  id: c.id,
  name: c.name,
  display_name: c.display_name,
  description: c.description,
  team: { id: c.team_id, name: c.team_name },
  type: c.type,
  incident_number: c.incident_number,
  created_by: c.created_by,
  created_at: c.created_at,
  message_count: c.message_count,
  last_activity_at: c.last_activity_at,
  web_url: c.web_url,
  member_count: c.member_count,
  members: c.members.map(member),
});

const notificationSent = (n: Notification) => ({
  id: n.id,
  to: n.username,
  type: n.type,
  title: n.title,
  body: n.body,
});

const messageView = (m: Message) => ({
  id: m.id,
  author: m.author.username,
  author_name: m.author.name,
  kind: m.kind,
  created_at: m.created_at,
  ...(m.importance !== 'normal' ? { importance: m.importance } : {}),
  ...(m.reply_to_id ? { reply_to_id: m.reply_to_id } : {}),
  ...(m.reply_count ? { reply_count: m.reply_count } : {}),
  ...(m.mentions.length ? { mentions: m.mentions } : {}),
  body: m.body,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const spec: McpServerSpec = {
  name: 'teams',
  title: 'Microsoft Teams (simulated)',
  version: '0.1.0',
  instructions: INSTRUCTIONS,
  register(server) {
    defineTool(server, 'list_teams', {
      title: 'List teams',
      description:
        'Lists Teams teams. By default there is one: Incident Response (id "incident-response"), which has a General channel and is where incident channels are created. Returns id, name, description and channel/member counts. Use a team id with list_channels or create_channel.',
      input: {
        q: z
          .string()
          .optional()
          .describe('Filter by text in the team id, name or description, e.g. "incident".'),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ q, limit, cursor }) => {
        const page = await api.listTeams({ q, limit, cursor });
        return {
          items: page.items.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            channel_count: t.channel_count,
            member_count: t.member_count,
          })),
          next_cursor: page.next_cursor,
          total: page.total,
        };
      },
    });

    defineTool(server, 'list_channels', {
      title: 'List channels',
      description:
        'Lists channels, most recently active first. Filter by team, member or text; incident_only returns incident channels (named inc<number>-<slug>). Use it to check whether an incident already has a channel before creating one. Returns compact summaries; use get_channel for members.',
      input: {
        q: z
          .string()
          .optional()
          .describe(
            'Text in the channel name, display name or description, e.g. "inc0010234" or "customer-profile".',
          ),
        team: z.string().optional().describe('Team id or name, e.g. "incident-response".'),
        member: userRef('Only channels this person is a member of').optional(),
        incident_only: z.boolean().optional().describe('Only incident channels (inc<number>-...).'),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ q, team, member: m, incident_only, limit, cursor }) => {
        const page = await api.listChannels({
          q,
          team_id: team,
          member: m,
          incident_only,
          limit,
          cursor,
        });
        return {
          items: page.items.map((c) => ({
            id: c.id,
            name: c.name,
            team: c.team_name,
            description: c.description,
            incident_number: c.incident_number,
            member_count: c.member_count,
            message_count: c.message_count,
            last_activity_at: c.last_activity_at,
            web_url: c.web_url,
          })),
          next_cursor: page.next_cursor,
          total: page.total,
        };
      },
    });

    defineTool(server, 'get_channel', {
      title: 'Get channel',
      description:
        'Gets one channel with its full member list: username, name, title, role (owner/member), the reason each person was added, presence, and who added them. Use read_messages for the conversation.',
      input: { channel: channelRef },
      annotations: READ_ONLY,
      run: async ({ channel }) => channelView(await api.getChannel(channel)),
    });

    defineTool(server, 'create_channel', {
      title: 'Create channel',
      description:
        'Creates a channel (by default in the "Incident Response" team) and adds the initial members. Name incident channels inc<number>-<short-slug> using the ServiceNow incident number, e.g. "inc0010234-customer-profile-errors"; names are lowercased and slugified (max 50 chars). The creator (default svc_incident_auto) becomes owner. Each member gets an activity notification stating their reason and listing everyone else in the channel. Fails with a conflict if the channel already exists (then use add_channel_members). Returns the channel with members, its web_url and the notifications sent.',
      input: {
        name: z
          .string()
          .min(1)
          .describe(
            'Channel name, e.g. "inc0010234-customer-profile-errors". Lowercase slug; "#" is optional.',
          ),
        description: z
          .string()
          .min(1)
          .describe(
            'Purpose shown in the channel header and in notifications, e.g. "P2 CIF - Customer Information File: customer profile lookups failing with 500s since 14:05 ET. ServiceNow INC0010234."',
          ),
        display_name: z
          .string()
          .optional()
          .describe('Optional human title; defaults to e.g. "INC0010234 Customer Profile Errors".'),
        team: z
          .string()
          .optional()
          .describe('Team id or name. Default "incident-response" (the only team at baseline).'),
        type: z
          .enum(['standard', 'private'])
          .optional()
          .describe('Default "standard". Use "private" for security-sensitive incidents.'),
        members: z
          .array(memberShape)
          .max(50)
          .optional()
          .describe(
            'Initial members with reasons. More can be added later with add_channel_members.',
          ),
        created_by: userRef('Creator (becomes owner). Default svc_incident_auto').optional(),
      },
      annotations: WRITE,
      run: async ({ name, description, display_name, team, type, members, created_by }) => {
        const created = await api.createChannel({
          team_id: team,
          name,
          description,
          display_name,
          type,
          members,
          created_by,
        });
        return {
          channel: channelView(created),
          notifications_sent: created.notifications.map(notificationSent),
        };
      },
    });

    defineTool(server, 'add_channel_members', {
      title: 'Add channel members',
      description:
        'Adds people to a channel with a reason and role. Idempotent per person: existing members are left unchanged and reported in already_members. For each newly added person the channel gets a system message ("Incident Automation added Priya Shah to the channel as CIF on-call.") and the person gets an added_to_channel notification: "You\'ve been added to #<channel> as <reason>. Here\'s who else is in the channel: Name (reason or title), ...". Returns who was added, who already was a member, and the notifications sent.',
      input: {
        channel: channelRef,
        members: z.array(memberShape).min(1).max(50).describe('People to add, each with a reason.'),
        added_by: userRef('Who is adding them. Default svc_incident_auto').optional(),
      },
      annotations: IDEMPOTENT_WRITE,
      run: async ({ channel, members, added_by }) => {
        const result = await api.addChannelMembers(channel, { members, added_by });
        return {
          channel_id: result.channel_id,
          channel_name: result.channel_name,
          web_url: result.web_url,
          added: result.added.map((m) => ({
            username: m.username,
            name: m.name,
            title: m.title,
            role: m.role,
            reason: m.reason,
            presence: m.presence,
          })),
          already_members: result.already_members.map((m) => m.username),
          notifications_sent: result.notifications.map(notificationSent),
          member_count: result.member_count,
        };
      },
    });

    defineTool(server, 'remove_channel_member', {
      title: 'Remove channel member',
      description:
        'Removes one person from a channel (e.g. they were added by mistake or handed off). Posts a system message in the channel. The person keeps their notifications. Returns the removed member and the new member count.',
      input: {
        channel: channelRef,
        user: userRef('Person to remove'),
        removed_by: userRef('Who is removing them. Default svc_incident_auto').optional(),
      },
      annotations: IDEMPOTENT_WRITE,
      run: async ({ channel, user, removed_by }) => {
        const result = await api.removeChannelMember(channel, user, removed_by);
        return {
          channel_id: result.channel_id,
          channel_name: result.channel_name,
          removed: { username: result.removed.username, name: result.removed.name },
          member_count: result.member_count,
        };
      },
    });

    defineTool(server, 'post_message', {
      title: 'Post message',
      description:
        'Posts a message to a channel, or a threaded reply when reply_to_id is set. The body is markdown (**bold**, _italic_, `code`, ```code blocks```, [links](url), - bullet lists). Write @username in the body to mention someone (or pass mentions); each mentioned person gets a "mention" notification, and the parent author gets a "reply" notification for replies. Use importance "high" or "urgent" for P1/P2 announcements. Returns the message id (use it with read_messages since=) and the notifications sent.',
      input: {
        channel: channelRef,
        body: z
          .string()
          .min(1)
          .describe(
            'Markdown message, e.g. "**Update:** errors started 14:05 ET after customer-profile-api 4.12.0. @kstreich can you confirm the rollback plan?"',
          ),
        mentions: z
          .array(z.string())
          .optional()
          .describe(
            'Extra usernames/emails to notify, in addition to @username tokens in the body.',
          ),
        importance: z
          .enum(['normal', 'high', 'urgent'])
          .optional()
          .describe(
            'Default "normal". "high" shows an IMPORTANT banner, "urgent" an URGENT banner.',
          ),
        reply_to_id: z
          .string()
          .optional()
          .describe('Message id (msg_...) to reply to in a thread.'),
        author: userRef('Author. Default svc_incident_auto (Incident Automation)').optional(),
      },
      annotations: WRITE,
      run: async ({ channel, body, mentions, importance, reply_to_id, author }) => {
        const posted = await api.postMessage(channel, {
          body,
          mentions,
          importance,
          reply_to_id,
          author,
        });
        return {
          id: posted.id,
          channel_id: posted.channel_id,
          author: posted.author.username,
          created_at: posted.created_at,
          importance: posted.importance,
          reply_to_id: posted.reply_to_id,
          mentions: posted.mentions,
          web_url: posted.web_url,
          notifications_sent: posted.notifications.map((n) => ({ to: n.username, type: n.type })),
        };
      },
    });

    defineTool(server, 'read_messages', {
      title: 'Read messages',
      description:
        'Reads a channel\'s messages oldest to newest, including system messages (member added/removed) and threaded replies (reply_to_id). Pass since=<last message id you saw> (or an ISO time / "15m") to get only newer messages, e.g. to see what people replied. Paginate with cursor.',
      input: {
        channel: channelRef,
        since: z
          .string()
          .optional()
          .describe(
            'Only messages after this point: a message id ("msg_000231"), ISO time ("2026-11-09T14:05:00Z") or relative ("15m", "2h", "1d").',
          ),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ channel, since, limit, cursor }) => {
        const page = await api.listMessages(channel, { since, limit, cursor });
        return {
          items: page.items.map(messageView),
          next_cursor: page.next_cursor,
          total: page.total,
        };
      },
    });

    defineTool(server, 'list_notifications', {
      title: 'List notifications',
      description:
        "Lists a person's Teams activity feed, newest first: added_to_channel (with the reason and who else is in the channel), mention and reply notifications. Useful to verify what someone was told when they were pulled into an incident. Returns unread_count too.",
      input: {
        user: userRef('Whose activity feed'),
        unread_only: z.boolean().optional().describe('Only unread notifications.'),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ user, unread_only, limit, cursor }) => {
        const page = await api.listNotifications(user, { unread_only, limit, cursor });
        return {
          unread_count: page.unread_count,
          items: page.items.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            channel_id: n.channel_id,
            channel_name: n.channel_name,
            message_id: n.message_id,
            actor: n.actor.username,
            created_at: n.created_at,
            read: n.read,
          })),
          next_cursor: page.next_cursor,
          total: page.total,
        };
      },
    });
  },
};
