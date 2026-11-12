import type { Health, Page, ResetResult } from '../common';
import { createHttp, type QueryValue, toQuery } from '../http';
import type {
  ActivityEvent,
  ActivityStreamQuery,
  ActivityTailQuery,
  ActivityTailResult,
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
  Communication,
  CommunicationDraftInput,
  CommunicationListQuery,
  CommunicationSendInput,
  CommunicationSummary,
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
  Problem,
  ProblemCreateInput,
  ProblemListQuery,
  ProblemStandup,
  ProblemSummary,
  ProblemUpdateInput,
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

    // Problems (the record behind the daily 8:00 AM problem stand-up)
    listProblems: (query: ProblemListQuery = {}) =>
      http.get<Page<ProblemSummary>>('/api/problems', q(query)),
    /** By PRB number or sys_id. */
    getProblem: (numberOrSysId: string) => http.get<Problem>(`/api/problems/${seg(numberOrSysId)}`),
    createProblem: (body: ProblemCreateInput) => http.post<Problem>('/api/problems', body),
    updateProblem: (numberOrSysId: string, body: ProblemUpdateInput) =>
      http.patch<Problem>(`/api/problems/${seg(numberOrSysId)}`, body),
    /** The agenda of a stand-up: `next` (default), `today` or a YYYY-MM-DD date. */
    problemStandup: (date = 'next') => http.get<ProblemStandup>('/api/problems/standup', { date }),

    // Critical Incident Communications (email drafts to the internal distribution groups)
    listCommunications: (query: CommunicationListQuery = {}) =>
      http.get<Page<CommunicationSummary>>('/api/communications', q(query)),
    /** By CIC number. */
    getCommunication: (number: string) =>
      http.get<Communication>(`/api/communications/${seg(number)}`),
    /** Drafts (or re-drafts) the communication of one kind for an incident. */
    draftCommunication: (incident: string, body: CommunicationDraftInput) =>
      http.post<Communication>(`/api/incidents/${seg(incident)}/communications`, body),
    /** Web UI only: a person sends the draft to the distribution group. */
    sendCommunication: (number: string, body: CommunicationSendInput = {}) =>
      http.post<Communication>(`/api/communications/${seg(number)}/send`, body),

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

    // Activity feed: every journal entry on incidents and change requests, in order
    /** `GET /api/activity/tail`: events after a seq cursor; can long-poll (`wait_seconds`). */
    activityTail: (query: ActivityTailQuery = {}) =>
      http.get<ActivityTailResult>('/api/activity/tail', q(query)),
    /**
     * URL of the Server-Sent Events stream: `event: activity`, `id: <seq>`, data =
     * ActivityEvent JSON. Starts live (or after `after_seq` / `Last-Event-ID`); `: heartbeat`
     * comments every 15s; `event: reset` when the API is reset (seqs restart).
     */
    activityStreamUrl: (query: ActivityStreamQuery = {}) =>
      `${baseUrl}/api/activity/stream${toQuery(q(query))}`,
    /**
     * Follows the feed by long-polling (no EventSource needed): yields events in seq order,
     * starting live, or after `after_seq` (0 replays history). Resyncs to live after a reset.
     * Stops when `signal` aborts.
     */
    followActivity: async function* (
      query: Omit<ActivityTailQuery, 'wait_seconds'> = {},
      opts: { signal?: AbortSignal; wait_seconds?: number } = {},
    ): AsyncGenerator<ActivityEvent> {
      const { after_seq, ...filters } = query;
      const wait_seconds = opts.wait_seconds ?? 25;
      let cursor = after_seq;
      let epoch: number | undefined;
      if (cursor === undefined) {
        const head = await http.get<ActivityTailResult>('/api/activity/tail', q({ limit: 1 }));
        cursor = head.last_seq;
        epoch = head.epoch;
      }
      while (!opts.signal?.aborted) {
        const r: ActivityTailResult = await http.get<ActivityTailResult>(
          '/api/activity/tail',
          q({ ...filters, after_seq: cursor, wait_seconds }),
        );
        if (epoch !== undefined && r.epoch !== epoch) {
          // World reset: seqs restarted. Skip the reseeded baseline, carry on live.
          epoch = r.epoch;
          cursor = r.last_seq;
          continue;
        }
        epoch = r.epoch;
        for (const event of r.items) yield event;
        cursor = r.cursor;
      }
    },

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
