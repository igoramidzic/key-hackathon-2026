import { createTeamsClient } from '@sim/contracts/teams';
import { useQuery } from '@tanstack/react-query';

/**
 * Path prefix the UI is served under: '' in multi-port dev (base '/'), '/teams' when built with
 * `vite build --base /teams/` for single-origin hosting. The REST API sits under the same prefix.
 */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Same-origin client under BASE_PATH; Vite proxies /api to the Teams API. */
export const api = createTeamsClient(BASE_PATH);

export const keys = {
  teams: ['teams'] as const,
  channels: ['channels'] as const,
  channel: (id: string) => ['channel', id] as const,
  messages: (id: string) => ['messages', id] as const,
  notifications: (user: string) => ['notifications', user] as const,
  user: (user: string) => ['user', user] as const,
  users: (q: string) => ['users', q] as const,
};

export function useTeams() {
  return useQuery({
    queryKey: keys.teams,
    queryFn: () => api.listTeams({ limit: 100 }),
    refetchInterval: 10_000,
  });
}

/** Every channel (the estate has a few dozen); polled so new incident channels appear live. */
export function useAllChannels() {
  return useQuery({
    queryKey: keys.channels,
    queryFn: () => api.listChannels({ limit: 500 }),
    refetchInterval: 3_000,
  });
}

export function useChannel(id: string) {
  return useQuery({
    queryKey: keys.channel(id),
    queryFn: () => api.getChannel(id),
    refetchInterval: 2_000,
  });
}

export function useMessages(id: string) {
  return useQuery({
    queryKey: keys.messages(id),
    queryFn: () => api.listMessages(id, { limit: 500 }),
    refetchInterval: 2_000,
  });
}

export function useNotifications(user: string) {
  return useQuery({
    queryKey: keys.notifications(user),
    queryFn: () => api.listNotifications(user, { limit: 100 }),
    refetchInterval: 2_500,
  });
}

export function useUser(user: string) {
  return useQuery({
    queryKey: keys.user(user),
    queryFn: () => api.getUser(user),
    staleTime: 60_000,
    retry: false,
  });
}
