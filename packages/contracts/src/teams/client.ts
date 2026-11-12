import type { Health, Page, ResetResult } from '../common';
import { ApiError, createHttp, type QueryValue, toQuery } from '../http';
import type {
  AddMembersInput,
  AddMembersResult,
  Channel,
  ChannelCreated,
  ChannelCreateInput,
  ChannelSummary,
  ChannelUpdateInput,
  ListChannelsQuery,
  ListMessagesQuery,
  ListNotificationsQuery,
  MarkReadResult,
  MeetingEnded,
  MeetingEndInput,
  MeetingStarted,
  MeetingStartInput,
  Message,
  MessageCreateInput,
  MessagePosted,
  NotificationPage,
  RemoveMemberResult,
  Team,
  TeamDetail,
  TeamsUser,
  TeamsUserDetail,
} from './types';

const enc = encodeURIComponent;

/**
 * Typed client for the Teams API. The teams system owns this file and adds methods; the ones
 * below are relied on by the simulator and must keep their signatures.
 */
export function createTeamsClient(baseUrl: string) {
  const http = createHttp(baseUrl);

  // createHttp has no DELETE; mirror its error handling here.
  const del = async <T>(path: string, query?: Record<string, QueryValue>): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}${toQuery(query)}`, { method: 'DELETE' });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : `DELETE ${path} failed with ${res.status}`;
      throw new ApiError(res.status, message, data);
    }
    return data as T;
  };

  return {
    http,
    health: () => http.get<Health>('/health'),
    reset: () => http.post<ResetResult>('/admin/reset'),

    // Teams
    listTeams: (query: { q?: string; limit?: number; cursor?: string } = {}) =>
      http.get<Page<Team>>('/api/teams', query),
    getTeam: (id: string) => http.get<TeamDetail>(`/api/teams/${enc(id)}`),

    // Channels
    listChannels: (query: ListChannelsQuery = {}) =>
      http.get<Page<ChannelSummary>>('/api/channels', { ...query }),
    getChannel: (id: string) => http.get<Channel>(`/api/channels/${enc(id)}`),
    createChannel: (body: ChannelCreateInput) => http.post<ChannelCreated>('/api/channels', body),
    /** Rename or re-describe a channel. Its id and web_url stay; the old name keeps resolving. */
    updateChannel: (id: string, body: ChannelUpdateInput) =>
      http.patch<Channel>(`/api/channels/${enc(id)}`, body),
    addChannelMembers: (id: string, body: AddMembersInput) =>
      http.post<AddMembersResult>(`/api/channels/${enc(id)}/members`, body),
    removeChannelMember: (id: string, user: string, removedBy?: string) =>
      del<RemoveMemberResult>(`/api/channels/${enc(id)}/members/${enc(user)}`, {
        removed_by: removedBy,
      }),

    // Meetings
    /** Turn the channel into a meeting. Returns the running one if there already is one. */
    startMeeting: (id: string, body: MeetingStartInput = {}) =>
      http.post<MeetingStarted>(`/api/channels/${enc(id)}/meeting`, body),
    endMeeting: (id: string, body: MeetingEndInput = {}) =>
      http.post<MeetingEnded>(`/api/channels/${enc(id)}/meeting/end`, body),

    // Messages
    listMessages: (id: string, query: ListMessagesQuery = {}) =>
      http.get<Page<Message>>(`/api/channels/${enc(id)}/messages`, { ...query }),
    postMessage: (id: string, body: MessageCreateInput) =>
      http.post<MessagePosted>(`/api/channels/${enc(id)}/messages`, body),

    // Users and notifications
    /** Search people (`q`), or look up specific `usernames` (usernames or emails). */
    listUsers: (
      query: { q?: string; usernames?: string[]; limit?: number; cursor?: string } = {},
    ) => http.get<Page<TeamsUser>>('/api/users', query),
    getUser: (user: string) => http.get<TeamsUserDetail>(`/api/users/${enc(user)}`),
    listNotifications: (user: string, query: ListNotificationsQuery = {}) =>
      http.get<NotificationPage>(`/api/users/${enc(user)}/notifications`, { ...query }),
    markNotificationsRead: (user: string, ids?: string[]) =>
      http.post<MarkReadResult>(`/api/users/${enc(user)}/notifications/read`, ids ? { ids } : {}),
  };
}

export type TeamsClient = ReturnType<typeof createTeamsClient>;
