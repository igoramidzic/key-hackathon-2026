import type { Health, Page, ResetResult } from '../common';
import { createHttp, type QueryValue } from '../http';
import type {
  AppDetail,
  AppListQuery,
  AppSummary,
  ChangeCreateInput,
  ChangeImportInput,
  ChangeListQuery,
  ChangeReleaseInput,
  ChangeRequest,
  ChangeRequestSummary,
  ChangeUpdateInput,
  DependencyDirection,
  DependencyGraph,
  GroupDetail,
  GroupListQuery,
  GroupSummary,
  Incident,
  IncidentCreateInput,
  IncidentListQuery,
  IncidentRef,
  IncidentSummary,
  IncidentUpdateInput,
  JournalEntry,
  JournalInput,
  LinkChildrenInput,
  UserDetail,
  UserListQuery,
  UserSummary,
} from './types';

const seg = (value: string) => encodeURIComponent(value);

/**
 * Typed client for the ServiceNow API. The servicenow system owns this file and adds methods;
 * the ones below are relied on by the simulator and must keep their signatures.
 */
export function createServiceNowClient(baseUrl: string) {
  const http = createHttp(baseUrl);
  const q = (query: object = {}) => query as Record<string, QueryValue>;
  return {
    http,
    health: () => http.get<Health>('/health'),
    reset: () => http.post<ResetResult>('/admin/reset'),
    /** Creates an incident. The response is the full `Incident` (a superset of `IncidentRef`). */
    createIncident: (body: IncidentCreateInput) => http.post<IncidentRef>('/api/incidents', body),

    // Incidents
    listIncidents: (query: IncidentListQuery = {}) =>
      http.get<Page<IncidentSummary>>('/api/incidents', q(query)),
    /** By INC number or sys_id. */
    getIncident: (numberOrSysId: string) =>
      http.get<Incident>(`/api/incidents/${seg(numberOrSysId)}`),
    /** Same as `createIncident`, typed with the full response. */
    openIncident: (body: IncidentCreateInput) => http.post<Incident>('/api/incidents', body),
    updateIncident: (numberOrSysId: string, body: IncidentUpdateInput) =>
      http.patch<Incident>(`/api/incidents/${seg(numberOrSysId)}`, body),
    addJournal: (numberOrSysId: string, body: JournalInput) =>
      http.post<JournalEntry>(`/api/incidents/${seg(numberOrSysId)}/journal`, body),
    /** Attaches incidents as children of `parent`; returns the parent. */
    linkChildren: (parent: string, body: LinkChildrenInput) =>
      http.post<Incident>(`/api/incidents/${seg(parent)}/children`, body),

    // Change requests (promotion from QV to production through KBR)
    listChanges: (query: ChangeListQuery = {}) =>
      http.get<Page<ChangeRequestSummary>>('/api/change_requests', q(query)),
    /** By CHG number or sys_id. */
    getChange: (numberOrSysId: string) =>
      http.get<ChangeRequest>(`/api/change_requests/${seg(numberOrSysId)}`),
    createChange: (body: ChangeCreateInput) =>
      http.post<ChangeRequest>('/api/change_requests', body),
    updateChange: (numberOrSysId: string, body: ChangeUpdateInput) =>
      http.patch<ChangeRequest>(`/api/change_requests/${seg(numberOrSysId)}`, body),
    addChangeJournal: (numberOrSysId: string, body: JournalInput) =>
      http.post<JournalEntry>(`/api/change_requests/${seg(numberOrSysId)}/journal`, body),
    /** Simulator only: imports a change with explicit timestamps (history, scenario setup). */
    importChange: (body: ChangeImportInput) =>
      http.post<ChangeRequest>('/admin/change_requests', body),
    /** Simulator only (KBR): records a release starting, succeeding or failing. */
    recordRelease: (numberOrSysId: string, body: ChangeReleaseInput) =>
      http.post<ChangeRequest>(`/admin/change_requests/${seg(numberOrSysId)}/release`, body),

    // CMDB
    listApps: (query: AppListQuery = {}) => http.get<Page<AppSummary>>('/api/apps', q(query)),
    getApp: (tla: string) => http.get<AppDetail>(`/api/apps/${seg(tla)}`),
    getAppDependencies: (
      tla: string,
      query: { direction?: DependencyDirection; depth?: number } = {},
    ) => http.get<DependencyGraph>(`/api/apps/${seg(tla)}/dependencies`, q(query)),

    // Groups and users
    listGroups: (query: GroupListQuery = {}) =>
      http.get<Page<GroupSummary>>('/api/groups', q(query)),
    /** By group id, sys_id or exact name. */
    getGroup: (idOrName: string) => http.get<GroupDetail>(`/api/groups/${seg(idOrName)}`),
    listUsers: (query: UserListQuery = {}) => http.get<Page<UserSummary>>('/api/users', q(query)),
    /** By username, email or sys_id. */
    getUser: (username: string) => http.get<UserDetail>(`/api/users/${seg(username)}`),
  };
}

export type ServiceNowClient = ReturnType<typeof createServiceNowClient>;
