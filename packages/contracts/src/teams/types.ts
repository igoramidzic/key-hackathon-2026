/**
 * Teams API types. Users are the shared world people: reference them by `username` (the same key
 * ServiceNow and GitLab use) or by email.
 */

import type { Page } from '../common';

export type Presence = 'available' | 'busy' | 'away' | 'offline';
export type ChannelType = 'standard' | 'private';
export type ChannelRole = 'owner' | 'member';
export type MessageImportance = 'normal' | 'high' | 'urgent';
export type MessageKind = 'message' | 'system';
export type NotificationType = 'added_to_channel' | 'mention' | 'reply' | 'meeting';

export interface PersonRef {
  username: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface TeamsUser {
  username: string;
  name: string;
  email: string;
  title: string;
  department: string;
  location: string;
  presence: Presence;
  is_bot: boolean;
  /** Activity feed for this user in the Teams UI. */
  web_url: string;
}

export interface TeamsUserDetail extends TeamsUser {
  teams: { id: string; name: string }[];
  channels: {
    id: string;
    name: string;
    display_name: string;
    team_id: string;
    team_name: string;
    role: ChannelRole;
    web_url: string;
  }[];
  unread_notifications: number;
}

// ---------------------------------------------------------------------------
// Teams and channels
// ---------------------------------------------------------------------------

export interface Team {
  /** Slug id, e.g. `incident-response`. Team names are also accepted wherever a team id is. */
  id: string;
  name: string;
  description: string;
  member_count: number;
  channel_count: number;
  web_url: string;
}

export interface TeamDetail extends Team {
  /** General first, then incident channels newest first, then the rest by name. */
  channels: ChannelSummary[];
}

export interface ChannelMember {
  username: string;
  name: string;
  email: string;
  title: string;
  presence: Presence;
  role: ChannelRole;
  /** Why this person is in the channel, e.g. `support for CIF - Customer Information File`. */
  reason: string | null;
  added_by: string;
  added_by_name: string;
  added_at: string;
}

/** A call held in a channel: the incident bridge, optionally recorded and transcribed. */
export interface Meeting {
  /** e.g. `mtg_000001`. */
  id: string;
  title: string;
  started_at: string;
  /** Username. */
  started_by: string;
  started_by_name: string;
  /** Null while the meeting is in progress. */
  ended_at: string | null;
  /** Set when the meeting has ended. */
  duration_seconds: number | null;
  recording: boolean;
  transcription: boolean;
  /** Facilitator, Teams' AI note-taker, is taking notes. */
  facilitator: boolean;
  /** `<channel web_url>?meeting=<id>`. */
  join_url: string;
}

export interface ChannelSummary {
  /**
   * e.g. `ch_3f9a1c2b7d`. Never changes. Channel names (current or previous) are also accepted
   * wherever a channel id is.
   */
  id: string;
  team_id: string;
  team_name: string;
  /** Lowercase slug, e.g. `inc0010234-customer-profile-errors`. Unique within a team. */
  name: string;
  /** Names the channel had before it was renamed, oldest first. They keep resolving to it. */
  previous_names: string[];
  /** Human title, e.g. `INC0010234 Customer Profile Errors`. */
  display_name: string;
  description: string;
  type: ChannelType;
  created_by: string;
  created_at: string;
  /** `INC0010234` when the channel name starts with `inc<number>`, else null. */
  incident_number: string | null;
  member_count: number;
  message_count: number;
  last_activity_at: string;
  /** The meeting in progress or, when none is, the most recent one. Null if there never was one. */
  meeting: Meeting | null;
  web_url: string;
}

export interface Channel extends ChannelSummary {
  members: ChannelMember[];
}

// ---------------------------------------------------------------------------
// Messages and notifications
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  channel_id: string;
  author: PersonRef;
  /** Markdown subset: **bold**, _italic_, `code`, ```fences```, [links](url), - lists, @username. */
  body: string;
  /** Usernames mentioned (parsed from `@username` in the body plus explicit mentions). */
  mentions: string[];
  importance: MessageImportance;
  /** Parent message id when this is a threaded reply. */
  reply_to_id: string | null;
  reply_count: number;
  kind: MessageKind;
  created_at: string;
  web_url: string;
}

export interface Notification {
  id: string;
  /** Recipient. */
  username: string;
  type: NotificationType;
  title: string;
  body: string;
  channel_id: string;
  channel_name: string;
  team_name: string;
  message_id: string | null;
  actor: PersonRef;
  created_at: string;
  read: boolean;
  web_url: string;
}

export type NotificationPage = Page<Notification> & { unread_count: number };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ChannelMemberInput {
  /** Username or email. */
  user: string;
  /** Why they are being added; shown in their notification and the members panel. */
  reason?: string;
  role?: ChannelRole;
}

export interface ChannelCreateInput {
  /** Team id or name. Defaults to `incident-response`. */
  team_id?: string;
  /** Slugified to lowercase, e.g. `inc0010234-customer-profile-errors`. */
  name: string;
  display_name?: string;
  description?: string;
  type?: ChannelType;
  members?: ChannelMemberInput[];
  /** Username or email. Defaults to `svc_incident_auto`. Becomes a channel owner. */
  created_by?: string;
}

/** `PATCH /api/channels/:id`: at least one of `name`, `display_name`, `description`. */
export interface ChannelUpdateInput {
  /** New slug (normalised like on create). The old name keeps resolving to the channel. */
  name?: string;
  /** New human title. Defaults to one derived from `name` when the old title was derived too. */
  display_name?: string;
  description?: string;
  /** Username or email. Defaults to `svc_incident_auto`. */
  updated_by?: string;
}

export interface MeetingStartInput {
  /** Defaults to the channel display name. */
  title?: string;
  /** Default true. */
  record?: boolean;
  /** Default true. */
  transcribe?: boolean;
  /** Default true. */
  facilitator?: boolean;
  /** Username or email. Defaults to `svc_incident_auto`. */
  started_by?: string;
}

export interface MeetingEndInput {
  /** Username or email. Defaults to `svc_incident_auto`. */
  ended_by?: string;
}

export interface AddMembersInput {
  members: ChannelMemberInput[];
  /** Username or email. Defaults to `svc_incident_auto`. */
  added_by?: string;
}

export interface MessageCreateInput {
  /** Username or email. Defaults to `svc_incident_auto`. */
  author?: string;
  body: string;
  /** Extra usernames/emails to mention (in addition to `@username` tokens in the body). */
  mentions?: string[];
  importance?: MessageImportance;
  reply_to_id?: string;
}

export interface ListChannelsQuery {
  q?: string;
  team_id?: string;
  /** Only channels this user (username or email) is a member of. */
  member?: string;
  /** Only incident channels (`inc<number>-…`). */
  incident_only?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ListMessagesQuery {
  /** ISO time, relative (`15m`, `2h`, `1d`) or a message id; returns messages strictly after it. */
  since?: string;
  limit?: number;
  cursor?: string;
}

export interface ListNotificationsQuery {
  unread_only?: boolean;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** `POST /api/channels`: the channel plus the notifications sent to initial members. */
export type ChannelCreated = Channel & { notifications: Notification[] };

export interface AddMembersResult {
  channel_id: string;
  channel_name: string;
  web_url: string;
  added: ChannelMember[];
  /** Requested users that were already members (left unchanged). */
  already_members: ChannelMember[];
  notifications: Notification[];
  member_count: number;
}

export interface RemoveMemberResult {
  channel_id: string;
  channel_name: string;
  removed: ChannelMember;
  member_count: number;
}

/**
 * `POST /api/channels/:id/meeting`. Idempotent: while a meeting is in progress it is returned
 * again with `already_running: true` and nobody is notified.
 */
export interface MeetingStarted {
  meeting: Meeting;
  channel: ChannelSummary;
  /** "Join the call" notifications sent to every member except the starter. */
  notifications: Notification[];
  already_running: boolean;
}

/** `POST /api/channels/:id/meeting/end`. */
export interface MeetingEnded {
  meeting: Meeting;
  channel: ChannelSummary;
}

/** `POST /api/channels/:id/messages`: the message plus mention/reply notifications sent. */
export type MessagePosted = Message & { notifications: Notification[] };

export interface MarkReadResult {
  marked_read: number;
  unread_count: number;
}
