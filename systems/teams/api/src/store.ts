import { badRequest, conflict, notFound } from '@sim/api-kit';
import { URLS } from '@sim/contracts';
import type {
  AddMembersResult,
  Channel,
  ChannelMember,
  ChannelMemberInput,
  ChannelRole,
  ChannelSummary,
  ChannelType,
  Meeting,
  Message,
  MessageImportance,
  MessageKind,
  Notification,
  NotificationType,
  RemoveMemberResult,
  Team,
  TeamDetail,
  TeamsUserDetail,
} from '@sim/contracts/teams';
import { getWorld, hashString, PERSONAS, type Person, slugify } from '@sim/world';
import { activityUrl, findPerson, requirePerson, toTeamsUser } from './users';

export const DEFAULT_TEAM_ID = 'incident-response';
export const BOT = PERSONAS.incidentBot;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface TeamRec {
  id: string;
  name: string;
  description: string;
  members: Set<string>;
  created_at: Date;
}

interface MemberRec {
  username: string;
  role: ChannelRole;
  reason: string | null;
  added_by: string;
  added_at: Date;
}

interface ChannelRec {
  id: string;
  team_id: string;
  name: string;
  display_name: string;
  description: string;
  type: ChannelType;
  created_by: string;
  created_at: Date;
  members: Map<string, MemberRec>;
  messages: MessageRec[];
  /** Names the channel had before renames, oldest first. They keep resolving to it. */
  previous_names: string[];
  /** The meeting in progress, or the most recent one. */
  meeting: MeetingRec | null;
}

interface MeetingRec {
  id: string;
  title: string;
  started_at: Date;
  started_by: string;
  ended_at: Date | null;
  recording: boolean;
  transcription: boolean;
  facilitator: boolean;
}

interface MessageRec {
  id: string;
  channel_id: string;
  author: string;
  body: string;
  mentions: string[];
  importance: MessageImportance;
  reply_to_id: string | null;
  kind: MessageKind;
  created_at: Date;
}

interface NotificationRec {
  id: string;
  username: string;
  type: NotificationType;
  title: string;
  body: string;
  channel_id: string;
  message_id: string | null;
  actor: string;
  created_at: Date;
  read: boolean;
}

export interface CreateChannelArgs {
  team_id?: string;
  name: string;
  display_name?: string;
  description?: string;
  type?: ChannelType;
  members?: ChannelMemberInput[];
  created_by?: string;
}

export interface UpdateChannelArgs {
  name?: string;
  display_name?: string;
  description?: string;
  updated_by?: string;
}

export interface StartMeetingArgs {
  title?: string;
  record?: boolean;
  transcribe?: boolean;
  facilitator?: boolean;
  started_by?: string;
}

export interface PostMessageArgs {
  author?: string;
  body: string;
  mentions?: string[];
  importance?: MessageImportance;
  reply_to_id?: string | null;
  kind?: MessageKind;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_CHANNEL_NAME = 50;

export function normalizeChannelName(input: string): string {
  let slug = input
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_CHANNEL_NAME) {
    const cut = slug.slice(0, MAX_CHANNEL_NAME);
    slug = cut.includes('-') ? cut.replace(/-[^-]*$/, '') : cut;
  }
  if (!slug) throw badRequest('Channel name must contain letters or digits');
  return slug;
}

const ACRONYMS = new Set([
  'api',
  'dns',
  'sftp',
  'ssl',
  'tls',
  'db',
  'gke',
  'gcp',
  'mq',
  'ui',
  'eod',
  'dr',
  'p1',
  'p2',
  'p3',
  'pir',
  'atm',
  'ivr',
  'kyc',
  'aml',
  'oauth',
  'jwks',
  'nacha',
  'rtp',
]);

/** ServiceNow record numbers inside a slug, e.g. the `prb0040001` of a renamed incident channel. */
const RECORD_NUMBER = /^(inc|prb|chg)\d{4,}$/;

const titleWords = (slug: string) =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) =>
      ACRONYMS.has(w) || RECORD_NUMBER.test(w) || getWorld().appsByTla.has(w.toUpperCase())
        ? w.toUpperCase()
        : w[0]!.toUpperCase() + w.slice(1),
    )
    .join(' ');

export function incidentNumberOf(name: string): string | null {
  const match = name.match(/^inc(\d{4,})(?:-|$)/);
  return match ? `INC${match[1]}` : null;
}

export function defaultDisplayName(name: string): string {
  const match = name.match(/^inc(\d{4,})(?:-(.*))?$/);
  if (match) return `INC${match[1]}${match[2] ? ` ${titleWords(match[2])}` : ''}`;
  return titleWords(name);
}

/** `45 sec`, `12 min`, `1 h 5 min`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/** `support for CIF.` → `support for CIF`; `as CIF on-call` → `CIF on-call`. */
function cleanReason(reason: string | undefined | null): string | null {
  const text = reason
    ?.trim()
    .replace(/^as\s+/i, '')
    .replace(/[.\s]+$/, '');
  return text ? text : null;
}

function plainExcerpt(body: string, max = 280): string {
  const text = body
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split('\n')
    .map((line) => line.replace(/^\s*([-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const MENTION_RE = /(^|[^\w.@])@([a-z0-9][a-z0-9_.-]*)/gi;

/** Usernames referenced as `@username` in a message body (known people only). */
export function parseMentions(body: string): string[] {
  const people = getWorld().peopleByUsername;
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const username = match[2]!.replace(/[.\-_]+$/, '').toLowerCase();
    if (people.has(username) && !out.includes(username)) out.push(username);
  }
  return out;
}

const durationSeconds = (meeting: MeetingRec): number | null =>
  meeting.ended_at
    ? Math.round((meeting.ended_at.getTime() - meeting.started_at.getTime()) / 1000)
    : null;

const personName = (username: string) => findPerson(username)?.name ?? username;
const ref = (username: string) => ({ username, name: personName(username) });

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TeamsStore {
  readonly teams = new Map<string, TeamRec>();
  readonly channels = new Map<string, ChannelRec>();
  readonly messages = new Map<string, MessageRec>();
  readonly notifications: NotificationRec[] = [];
  private seq = { message: 0, notification: 0, meeting: 0 };

  // ----- lookups -----

  createTeam(spec: { id: string; name: string; description: string; members: string[]; at: Date }) {
    const team: TeamRec = {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      members: new Set(spec.members.filter((u) => findPerson(u))),
      created_at: spec.at,
    };
    this.teams.set(team.id, team);
    return team;
  }

  resolveTeam(input: string): TeamRec {
    const key = input.trim();
    const direct = this.teams.get(key) ?? this.teams.get(slugify(key));
    if (direct) return direct;
    for (const team of this.teams.values()) {
      if (team.name.toLowerCase() === key.toLowerCase()) return team;
    }
    throw notFound(
      `Unknown team '${input}'. Known teams: ${[...this.teams.values()].map((t) => `${t.id} (${t.name})`).join(', ')}`,
    );
  }

  resolveChannel(input: string): ChannelRec {
    const raw = input.trim();
    const byId = this.channels.get(raw);
    if (byId) return byId;
    let teamFilter: TeamRec | undefined;
    let nameRef = raw;
    const slash = raw.lastIndexOf('/');
    if (slash > 0) {
      teamFilter = this.resolveTeam(raw.slice(0, slash));
      nameRef = raw.slice(slash + 1);
    }
    let name: string;
    try {
      name = normalizeChannelName(nameRef);
    } catch {
      throw notFound(`Unknown channel '${input}'.`);
    }
    const inScope = [...this.channels.values()].filter(
      (c) => !teamFilter || c.team_id === teamFilter.id,
    );
    let matches = inScope.filter((c) => c.name === name);
    // A renamed channel still answers to its old names.
    if (!matches.length) matches = inScope.filter((c) => c.previous_names.includes(name));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw conflict(
        `Channel name '${name}' is ambiguous: ${matches.map((c) => `${c.id} (${this.teams.get(c.team_id)?.name})`).join(', ')}. Pass the channel id or '<team id>/${name}'.`,
      );
    }
    const incident = incidentNumberOf(name);
    const similar = [...this.channels.values()]
      .filter(
        (c) =>
          (incident && incidentNumberOf(c.name) === incident) ||
          c.name.includes(name) ||
          name.includes(c.name),
      )
      .filter((c) => c.name !== 'general')
      .slice(0, 5);
    const hint = similar.length
      ? ` Did you mean: ${similar.map((c) => `${c.name} (${c.id})`).join(', ')}?`
      : ' Use list_channels / GET /api/channels?q= to find it.';
    throw notFound(`Unknown channel '${input}'.${hint}`);
  }

  /** The channel in a team that has this name now, else the one that used to have it. */
  private channelNamed(teamId: string, name: string): ChannelRec | undefined {
    const inTeam = this.channelsOf(teamId);
    return (
      inTeam.find((c) => c.name === name) ?? inTeam.find((c) => c.previous_names.includes(name))
    );
  }

  private ensureTeamMember(team: TeamRec, username: string) {
    team.members.add(username);
  }

  // ----- channels -----

  createChannel(
    args: CreateChannelArgs,
    at = new Date(),
    opts: { silent?: boolean } = {},
  ): { channel: ChannelRec; notifications: NotificationRec[] } {
    const team = this.resolveTeam(args.team_id ?? DEFAULT_TEAM_ID);
    const name = normalizeChannelName(args.name);
    const existing = this.channelNamed(team.id, name);
    if (existing) {
      const renamed = existing.name === name ? '' : `, since renamed to #${existing.name}`;
      throw conflict(
        `Channel #${name} already exists in ${team.name} (id ${existing.id}${renamed}, ${this.channelUrl(existing)}). Add people with POST /api/channels/${existing.id}/members (MCP: add_channel_members).`,
      );
    }
    const creator = requirePerson(args.created_by ?? BOT, 'created_by user');
    // Validate members before mutating anything.
    for (const m of args.members ?? []) requirePerson(m.user);

    let id = '';
    for (let salt = 0; !id || this.channels.has(id); salt++) {
      id = `ch_${hashString(`${team.id}/${name}/${this.channels.size}/${salt}`).toString(16).padStart(8, '0')}`;
    }
    const channel: ChannelRec = {
      id,
      team_id: team.id,
      name,
      display_name: args.display_name?.trim() || defaultDisplayName(name),
      description: args.description?.trim() ?? '',
      type: args.type ?? 'standard',
      created_by: creator.username,
      created_at: at,
      members: new Map(),
      messages: [],
      previous_names: [],
      meeting: null,
    };
    this.channels.set(id, channel);
    this.ensureTeamMember(team, creator.username);
    channel.members.set(creator.username, {
      username: creator.username,
      role: 'owner',
      reason: null,
      added_by: creator.username,
      added_at: at,
    });
    if (!opts.silent) {
      this.appendMessage(channel, {
        author: creator.username,
        body: `${creator.name} created the channel #${name}.`,
        kind: 'system',
        at,
      });
    }
    const { notifications } = args.members?.length
      ? this.addMembers(channel, args.members, creator.username, at, opts)
      : { notifications: [] };
    return { channel, notifications };
  }

  /**
   * Renames and/or re-describes a channel. The id and URL stay, the old name becomes an alias, and
   * the channel gets one system message. A call that changes nothing is a no-op.
   */
  updateChannel(channel: ChannelRec, args: UpdateChannelArgs, at = new Date()): ChannelRec {
    if (
      args.name === undefined &&
      args.display_name === undefined &&
      args.description === undefined
    ) {
      throw badRequest('Nothing to update: pass at least one of name, display_name, description');
    }
    const actor = requirePerson(args.updated_by ?? BOT, 'updated_by user');
    const team = this.teams.get(channel.team_id)!;
    const name = args.name === undefined ? channel.name : normalizeChannelName(args.name);
    if (name !== channel.name) {
      const taken = this.channelNamed(team.id, name);
      if (taken && taken !== channel) {
        const renamed = taken.name === name ? '' : `, since renamed to #${taken.name}`;
        throw conflict(
          `Channel name #${name} is already taken in ${team.name} (id ${taken.id}${renamed}, ${this.channelUrl(taken)}). Pick another name.`,
        );
      }
    }
    let displayName = channel.display_name;
    if (args.display_name !== undefined) {
      displayName = args.display_name.trim() || defaultDisplayName(name);
    } else if (name !== channel.name && displayName === defaultDisplayName(channel.name)) {
      // The title was derived from the old name, so it follows the new one.
      displayName = defaultDisplayName(name);
    }
    const description =
      args.description === undefined ? channel.description : args.description.trim();

    const renamed = name !== channel.name || displayName !== channel.display_name;
    const described = description !== channel.description;
    if (!renamed && !described) return channel;

    const shown = displayName !== channel.display_name ? displayName : `#${name}`;
    if (name !== channel.name) {
      channel.previous_names = [...channel.previous_names.filter((n) => n !== name), channel.name];
      channel.name = name;
    }
    channel.display_name = displayName;
    channel.description = description;
    this.appendMessage(channel, {
      author: actor.username,
      body: renamed
        ? `${actor.name} renamed the channel to ${shown}${described ? ' and updated the description' : ''}.`
        : `${actor.name} updated the channel description.`,
      kind: 'system',
      at,
    });
    return channel;
  }

  addMembers(
    channel: ChannelRec,
    inputs: ChannelMemberInput[],
    addedBy: string = BOT,
    at = new Date(),
    opts: { silent?: boolean } = {},
  ): { added: MemberRec[]; already: MemberRec[]; notifications: NotificationRec[] } {
    const actor = requirePerson(addedBy, 'added_by user');
    const resolved = inputs.map((input) => ({ input, person: requirePerson(input.user) }));
    const team = this.teams.get(channel.team_id)!;
    const added: MemberRec[] = [];
    const already: MemberRec[] = [];
    for (const { input, person } of resolved) {
      const existing = channel.members.get(person.username);
      if (existing) {
        if (!already.includes(existing) && !added.includes(existing)) already.push(existing);
        continue;
      }
      const member: MemberRec = {
        username: person.username,
        role: input.role ?? 'member',
        reason: cleanReason(input.reason),
        added_by: actor.username,
        added_at: at,
      };
      channel.members.set(person.username, member);
      this.ensureTeamMember(team, person.username);
      added.push(member);
      if (!opts.silent) {
        this.appendMessage(channel, {
          author: actor.username,
          body: `${actor.name} added ${person.name} to the channel${member.reason ? ` as ${member.reason}` : ''}.`,
          kind: 'system',
          at,
        });
      }
    }
    const notifications: NotificationRec[] = [];
    if (!opts.silent) {
      for (const member of added) {
        if (member.username === actor.username) continue;
        notifications.push(
          this.notify({
            username: member.username,
            type: 'added_to_channel',
            title: `${actor.name} added you to #${channel.name}`,
            body: this.addedBody(channel, member),
            channel_id: channel.id,
            message_id: null,
            actor: actor.username,
            created_at: at,
          }),
        );
      }
    }
    return { added, already, notifications };
  }

  /** "You've been added to #x as …. Here's who else is in the channel: A (title), B (reason), …" */
  private addedBody(channel: ChannelRec, member: MemberRec): string {
    const others = [...channel.members.values()].filter((m) => {
      if (m.username === member.username) return false;
      const person = findPerson(m.username);
      return person && person.role !== 'bot';
    });
    const describe = (m: MemberRec) => {
      const person = findPerson(m.username)!;
      // Flatten nested parentheses: "support for X (on-call)" -> "support for X, on-call".
      const label = (m.reason ?? person.title).replace(/\s*\(([^)]*)\)/g, ', $1');
      return `${person.name} (${label})`;
    };
    const LIMIT = 12;
    let list = others.slice(0, LIMIT).map(describe).join(', ');
    if (others.length > LIMIT) list += `, and ${others.length - LIMIT} more`;
    const as = member.reason ? ` as ${member.reason}` : '';
    const intro = `You've been added to #${channel.name}${as}.`;
    const desc = channel.description ? ` Channel purpose: ${channel.description}` : '';
    return others.length
      ? `${intro} Here's who else is in the channel: ${list}.${desc}`
      : `${intro} No one else has been added yet.${desc}`;
  }

  removeMember(channel: ChannelRec, user: string, removedBy: string = BOT, at = new Date()) {
    const person = requirePerson(user);
    const actor = requirePerson(removedBy, 'removed_by user');
    const member = channel.members.get(person.username);
    if (!member) {
      throw notFound(
        `${person.name} (${person.username}) is not a member of #${channel.name}. Members: ${[...channel.members.keys()].join(', ')}`,
      );
    }
    channel.members.delete(person.username);
    this.appendMessage(channel, {
      author: actor.username,
      body:
        actor.username === person.username
          ? `${person.name} left the channel.`
          : `${actor.name} removed ${person.name} from the channel.`,
      kind: 'system',
      at,
    });
    return member;
  }

  // ----- meetings -----

  /**
   * Turns the channel into a meeting and asks every member (except the starter) to join. While one
   * is in progress it is returned as is: no second meeting, message or notification.
   */
  startMeeting(
    channel: ChannelRec,
    args: StartMeetingArgs = {},
    at = new Date(),
  ): { meeting: MeetingRec; notifications: NotificationRec[]; already_running: boolean } {
    const starter = requirePerson(args.started_by ?? BOT, 'started_by user');
    if (channel.meeting && !channel.meeting.ended_at) {
      return { meeting: channel.meeting, notifications: [], already_running: true };
    }
    this.seq.meeting++;
    const meeting: MeetingRec = {
      id: `mtg_${String(this.seq.meeting).padStart(6, '0')}`,
      title: args.title?.trim() || channel.display_name,
      started_at: at,
      started_by: starter.username,
      ended_at: null,
      recording: args.record ?? true,
      transcription: args.transcribe ?? true,
      facilitator: args.facilitator ?? true,
    };
    channel.meeting = meeting;
    const options = [
      meeting.recording && 'Recording on',
      meeting.transcription && 'Transcription on',
      meeting.facilitator && 'Facilitator taking notes',
    ].filter(Boolean);
    const message = this.appendMessage(channel, {
      author: starter.username,
      body: `Meeting started: ${meeting.title}.${options.length ? ` ${options.join(' · ')}.` : ''} Join: ${this.joinUrl(channel, meeting)}`,
      kind: 'system',
      at,
    });
    const notifications: NotificationRec[] = [];
    for (const member of channel.members.values()) {
      if (member.username === starter.username) continue;
      notifications.push(
        this.notify({
          username: member.username,
          type: 'meeting',
          title: `${starter.name} started a meeting in #${channel.name}`,
          body: `Join the call in #${channel.name}: ${meeting.title}`,
          channel_id: channel.id,
          message_id: message.id,
          actor: starter.username,
          created_at: at,
        }),
      );
    }
    return { meeting, notifications, already_running: false };
  }

  endMeeting(channel: ChannelRec, endedBy: string = BOT, at = new Date()): MeetingRec {
    const actor = requirePerson(endedBy, 'ended_by user');
    const meeting = channel.meeting;
    if (!meeting || meeting.ended_at) {
      const last = meeting?.ended_at
        ? ` The last one (${meeting.id}) ended at ${meeting.ended_at.toISOString()}.`
        : '';
      throw conflict(
        `No meeting is in progress in #${channel.name}.${last} Start one with POST /api/channels/${channel.id}/meeting (MCP: start_meeting).`,
      );
    }
    meeting.ended_at = new Date(Math.max(at.getTime(), meeting.started_at.getTime()));
    const saved = [meeting.recording && 'Recording', meeting.transcription && 'transcript']
      .filter(Boolean)
      .join(' and ');
    this.appendMessage(channel, {
      author: actor.username,
      body: `Meeting ended after ${formatDuration(durationSeconds(meeting)!)}.${
        saved ? ` ${saved[0]!.toUpperCase()}${saved.slice(1)} saved to the channel.` : ''
      }`,
      kind: 'system',
      at: meeting.ended_at,
    });
    return meeting;
  }

  // ----- messages -----

  private appendMessage(
    channel: ChannelRec,
    m: {
      author: string;
      body: string;
      kind: MessageKind;
      at: Date;
      mentions?: string[];
      importance?: MessageImportance;
      reply_to_id?: string | null;
    },
  ): MessageRec {
    this.seq.message++;
    const message: MessageRec = {
      id: `msg_${String(this.seq.message).padStart(6, '0')}`,
      channel_id: channel.id,
      author: m.author,
      body: m.body,
      mentions: m.mentions ?? [],
      importance: m.importance ?? 'normal',
      reply_to_id: m.reply_to_id ?? null,
      kind: m.kind,
      created_at: m.at,
    };
    channel.messages.push(message);
    this.messages.set(message.id, message);
    return message;
  }

  postMessage(
    channel: ChannelRec,
    args: PostMessageArgs,
    at = new Date(),
    opts: { silent?: boolean } = {},
  ): { message: MessageRec; notifications: NotificationRec[] } {
    const author = requirePerson(args.author ?? BOT, 'author');
    const body = args.body.replace(/\r\n/g, '\n').trim();
    if (!body) throw badRequest('Message body is required');
    let parent: MessageRec | undefined;
    if (args.reply_to_id) {
      parent = this.messages.get(args.reply_to_id);
      if (!parent || parent.channel_id !== channel.id) {
        throw notFound(`Message ${args.reply_to_id} is not in #${channel.name}`);
      }
      // Replies attach to the thread root.
      while (parent.reply_to_id) parent = this.messages.get(parent.reply_to_id)!;
    }
    const mentions = parseMentions(body);
    for (const extra of args.mentions ?? []) {
      const person = requirePerson(extra, 'mentioned user');
      if (!mentions.includes(person.username)) mentions.push(person.username);
    }
    const message = this.appendMessage(channel, {
      author: author.username,
      body,
      kind: args.kind ?? 'message',
      at,
      mentions,
      importance: args.importance,
      reply_to_id: parent?.id ?? null,
    });
    const notifications: NotificationRec[] = [];
    if (!opts.silent && message.kind === 'message') {
      const excerpt = plainExcerpt(body);
      for (const username of mentions) {
        if (username === author.username) continue;
        notifications.push(
          this.notify({
            username,
            type: 'mention',
            title: `${author.name} mentioned you in #${channel.name}`,
            body: excerpt,
            channel_id: channel.id,
            message_id: message.id,
            actor: author.username,
            created_at: at,
          }),
        );
      }
      if (parent && parent.author !== author.username && !mentions.includes(parent.author)) {
        const parentAuthor = findPerson(parent.author);
        if (parentAuthor && parentAuthor.role !== 'bot') {
          notifications.push(
            this.notify({
              username: parent.author,
              type: 'reply',
              title: `${author.name} replied to your message in #${channel.name}`,
              body: excerpt,
              channel_id: channel.id,
              message_id: message.id,
              actor: author.username,
              created_at: at,
            }),
          );
        }
      }
    }
    return { message, notifications };
  }

  listMessages(channel: ChannelRec, since?: { afterId?: string; afterTime?: Date }): MessageRec[] {
    if (since?.afterId) {
      const index = channel.messages.findIndex((m) => m.id === since.afterId);
      if (index === -1) throw notFound(`Message ${since.afterId} is not in #${channel.name}`);
      return channel.messages.slice(index + 1);
    }
    if (since?.afterTime) {
      const t = since.afterTime.getTime();
      return channel.messages.filter((m) => m.created_at.getTime() > t);
    }
    return channel.messages;
  }

  // ----- notifications -----

  private notify(n: Omit<NotificationRec, 'id' | 'read'>): NotificationRec {
    this.seq.notification++;
    const rec: NotificationRec = {
      ...n,
      id: `ntf_${String(this.seq.notification).padStart(6, '0')}`,
      read: false,
    };
    this.notifications.push(rec);
    return rec;
  }

  notificationsFor(username: string, unreadOnly = false): NotificationRec[] {
    return this.notifications
      .filter((n) => n.username === username && (!unreadOnly || !n.read))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
  }

  unreadCount(username: string): number {
    return this.notifications.filter((n) => n.username === username && !n.read).length;
  }

  markRead(username: string, ids?: string[]): number {
    let count = 0;
    const wanted = ids ? new Set(ids) : null;
    if (wanted) {
      for (const id of wanted) {
        const n = this.notifications.find((x) => x.id === id);
        if (!n || n.username !== username) {
          throw notFound(`Notification ${id} does not belong to ${username}`);
        }
      }
    }
    for (const n of this.notifications) {
      if (n.username !== username || n.read) continue;
      if (wanted && !wanted.has(n.id)) continue;
      n.read = true;
      count++;
    }
    return count;
  }

  // ----- views -----

  channelUrl(channel: ChannelRec): string {
    return `${URLS.teams.web}/channels/${channel.id}`;
  }

  joinUrl(channel: ChannelRec, meeting: MeetingRec): string {
    return `${this.channelUrl(channel)}?meeting=${meeting.id}`;
  }

  toMeeting(channel: ChannelRec, meeting: MeetingRec): Meeting {
    return {
      id: meeting.id,
      title: meeting.title,
      started_at: meeting.started_at.toISOString(),
      started_by: meeting.started_by,
      started_by_name: personName(meeting.started_by),
      ended_at: meeting.ended_at?.toISOString() ?? null,
      duration_seconds: durationSeconds(meeting),
      recording: meeting.recording,
      transcription: meeting.transcription,
      facilitator: meeting.facilitator,
      join_url: this.joinUrl(channel, meeting),
    };
  }

  lastActivity(channel: ChannelRec): Date {
    return channel.messages.at(-1)?.created_at ?? channel.created_at;
  }

  toTeam(team: TeamRec): Team {
    const channels = [...this.channels.values()].filter((c) => c.team_id === team.id);
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      member_count: team.members.size,
      channel_count: channels.length,
      web_url: `${URLS.teams.web}/teams/${team.id}`,
    };
  }

  toTeamDetail(team: TeamRec): TeamDetail {
    return {
      ...this.toTeam(team),
      channels: this.sortChannels(this.channelsOf(team.id)).map((c) => this.toSummary(c)),
    };
  }

  channelsOf(teamId: string): ChannelRec[] {
    return [...this.channels.values()].filter((c) => c.team_id === teamId);
  }

  /** General first, then incident channels newest first, then the rest by name. */
  sortChannels(channels: ChannelRec[]): ChannelRec[] {
    const rank = (c: ChannelRec) => (c.name === 'general' ? 0 : incidentNumberOf(c.name) ? 1 : 2);
    return [...channels].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (rank(a) === 1) return b.created_at.getTime() - a.created_at.getTime();
      return a.name.localeCompare(b.name);
    });
  }

  toSummary(channel: ChannelRec): ChannelSummary {
    return {
      id: channel.id,
      team_id: channel.team_id,
      team_name: this.teams.get(channel.team_id)?.name ?? channel.team_id,
      name: channel.name,
      previous_names: [...channel.previous_names],
      display_name: channel.display_name,
      description: channel.description,
      type: channel.type,
      created_by: channel.created_by,
      created_at: channel.created_at.toISOString(),
      incident_number: incidentNumberOf(channel.name),
      member_count: channel.members.size,
      message_count: channel.messages.length,
      last_activity_at: this.lastActivity(channel).toISOString(),
      meeting: channel.meeting ? this.toMeeting(channel, channel.meeting) : null,
      web_url: this.channelUrl(channel),
    };
  }

  toMember(member: MemberRec): ChannelMember {
    const person = findPerson(member.username) as Person;
    const user = toTeamsUser(person);
    return {
      username: member.username,
      name: person.name,
      email: person.email,
      title: person.title,
      presence: user.presence,
      role: member.role,
      reason: member.reason,
      added_by: member.added_by,
      added_by_name: personName(member.added_by),
      added_at: member.added_at.toISOString(),
    };
  }

  toChannel(channel: ChannelRec): Channel {
    const members = [...channel.members.values()].sort((a, b) => {
      if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
      return a.added_at.getTime() - b.added_at.getTime();
    });
    return { ...this.toSummary(channel), members: members.map((m) => this.toMember(m)) };
  }

  toMessage(message: MessageRec): Message {
    const channel = this.channels.get(message.channel_id)!;
    return {
      id: message.id,
      channel_id: message.channel_id,
      author: ref(message.author),
      body: message.body,
      mentions: message.mentions,
      importance: message.importance,
      reply_to_id: message.reply_to_id,
      reply_count: message.reply_to_id
        ? 0
        : channel.messages.filter((m) => m.reply_to_id === message.id).length,
      kind: message.kind,
      created_at: message.created_at.toISOString(),
      web_url: `${this.channelUrl(channel)}#${message.id}`,
    };
  }

  toNotification(n: NotificationRec): Notification {
    const channel = this.channels.get(n.channel_id);
    const team = channel ? this.teams.get(channel.team_id) : undefined;
    const anchor = n.message_id ? `#${n.message_id}` : '';
    return {
      id: n.id,
      username: n.username,
      type: n.type,
      title: n.title,
      body: n.body,
      channel_id: n.channel_id,
      channel_name: channel?.name ?? n.channel_id,
      team_name: team?.name ?? '',
      message_id: n.message_id,
      actor: ref(n.actor),
      created_at: n.created_at.toISOString(),
      read: n.read,
      web_url: `${URLS.teams.web}/channels/${n.channel_id}?user=${encodeURIComponent(n.username)}${anchor}`,
    };
  }

  toAddResult(
    channel: ChannelRec,
    result: { added: MemberRec[]; already: MemberRec[]; notifications: NotificationRec[] },
  ): AddMembersResult {
    return {
      channel_id: channel.id,
      channel_name: channel.name,
      web_url: this.channelUrl(channel),
      added: result.added.map((m) => this.toMember(m)),
      already_members: result.already.map((m) => this.toMember(m)),
      notifications: result.notifications.map((n) => this.toNotification(n)),
      member_count: channel.members.size,
    };
  }

  toRemoveResult(channel: ChannelRec, member: MemberRec): RemoveMemberResult {
    return {
      channel_id: channel.id,
      channel_name: channel.name,
      removed: this.toMember(member),
      member_count: channel.members.size,
    };
  }

  userDetail(person: Person): TeamsUserDetail {
    const teams = [...this.teams.values()]
      .filter((t) => t.members.has(person.username))
      .map((t) => ({ id: t.id, name: t.name }));
    const channels = [...this.channels.values()]
      .filter((c) => c.members.has(person.username))
      .sort((a, b) => this.lastActivity(b).getTime() - this.lastActivity(a).getTime())
      .map((c) => ({
        id: c.id,
        name: c.name,
        display_name: c.display_name,
        team_id: c.team_id,
        team_name: this.teams.get(c.team_id)?.name ?? c.team_id,
        role: c.members.get(person.username)!.role,
        web_url: this.channelUrl(c),
      }));
    return {
      ...toTeamsUser(person),
      web_url: activityUrl(person.username),
      teams,
      channels,
      unread_notifications: this.unreadCount(person.username),
    };
  }

  stats() {
    return {
      teams: this.teams.size,
      channels: this.channels.size,
      messages: this.messages.size,
      notifications_unread: this.notifications.filter((n) => !n.read).length,
    };
  }
}

export type { ChannelRec, MeetingRec, MessageRec, NotificationRec, TeamRec };
