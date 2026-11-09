import {
  type AppListQuery,
  createServiceNowClient,
  type GroupListQuery,
  type IncidentCreateInput,
  type IncidentListQuery,
  type IncidentUpdateInput,
  type JournalInput,
  type UserListQuery,
} from '@sim/contracts/servicenow';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Path prefix the UI is served under: '' in multi-port dev (base '/'), '/servicenow' when built with
 * `vite build --base /servicenow/` for single-origin hosting. The REST API sits under the same prefix.
 */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Same-origin client under BASE_PATH: Vite proxies /api, /admin and /health to the REST API. */
export const sn = createServiceNowClient(BASE_PATH);

/** The demo operator: Dana Whitfield, NOC shift lead. */
export const CURRENT_USER = 'dwhitfield';
export const CURRENT_USER_NAME = 'Dana Whitfield';

const LIVE = 5_000;

export function useIncidents(query: IncidentListQuery, live = true) {
  return useQuery({
    queryKey: ['incidents', query],
    queryFn: () => sn.listIncidents(query),
    refetchInterval: live ? LIVE : false,
    placeholderData: keepPreviousData,
  });
}

export function useIncident(number: string) {
  return useQuery({
    queryKey: ['incident', number],
    queryFn: () => sn.getIncident(number),
    refetchInterval: LIVE,
  });
}

export function useApps(query: AppListQuery) {
  return useQuery({
    queryKey: ['apps', query],
    queryFn: () => sn.listApps(query),
    placeholderData: keepPreviousData,
  });
}

export function useApp(tla: string | undefined) {
  return useQuery({
    queryKey: ['app', tla],
    queryFn: () => sn.getApp(tla!),
    enabled: !!tla,
    retry: false,
  });
}

export function useGroups(query: GroupListQuery) {
  return useQuery({
    queryKey: ['groups', query],
    queryFn: () => sn.listGroups(query),
    placeholderData: keepPreviousData,
  });
}

export function useGroup(id: string | undefined) {
  return useQuery({
    queryKey: ['group', id],
    queryFn: () => sn.getGroup(id!),
    enabled: !!id,
  });
}

export function useUsers(query: UserListQuery, enabled = true) {
  return useQuery({
    queryKey: ['users', query],
    queryFn: () => sn.listUsers(query),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useUser(username: string | undefined) {
  return useQuery({
    queryKey: ['user', username],
    queryFn: () => sn.getUser(username!),
    enabled: !!username,
  });
}

/** Updates an incident as the current user and refreshes everything incident-shaped. */
export function useUpdateIncident(number: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: IncidentUpdateInput) =>
      sn.updateIncident(number, { updated_by: CURRENT_USER, ...body }),
    onSuccess: (incident) => {
      client.setQueryData(['incident', number], incident);
      void client.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useAddJournal(number: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: JournalInput) => sn.addJournal(number, { author: CURRENT_USER, ...body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['incident', number] });
      void client.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useCreateIncident() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: IncidentCreateInput) => sn.openIncident(body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['incidents'] }),
  });
}
