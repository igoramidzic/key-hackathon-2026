import { URLS } from '../config';
import type {
  ActivityKind,
  ActivityTable,
  CauseCode,
  ChangeCloseCode,
  ChangeRisk,
  ChangeState,
  ChangeType,
  CloseCode,
  CommunicationKind,
  ContactType,
  GroupType,
  ImpactUrgency,
  IncidentCategory,
  IncidentRelationship,
  IncidentState,
  LinkType,
  Priority,
  ProblemState,
  ReleaseStatus,
} from './types';

export const INCIDENT_STATES: IncidentState[] = [
  'new',
  'in_progress',
  'on_hold',
  'resolved',
  'closed',
  'canceled',
];

export const ACTIVE_STATES: IncidentState[] = ['new', 'in_progress', 'on_hold'];

export const STATE_LABELS: Record<IncidentState, string> = {
  new: 'New',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  resolved: 'Resolved',
  closed: 'Closed',
  canceled: 'Canceled',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  1: '1 - Critical',
  2: '2 - High',
  3: '3 - Moderate',
  4: '4 - Low',
  5: '5 - Planning',
};

export const IMPACT_LABELS: Record<ImpactUrgency, string> = {
  1: '1 - High',
  2: '2 - Medium',
  3: '3 - Low',
};

export const INCIDENT_CATEGORIES: IncidentCategory[] = [
  'application',
  'network',
  'database',
  'access',
  'hardware',
  'batch_job',
  'performance',
  'inquiry',
];

export const CATEGORY_LABELS: Record<IncidentCategory, string> = {
  application: 'Application',
  network: 'Network',
  database: 'Database',
  access: 'Access',
  hardware: 'Hardware',
  batch_job: 'Batch Job',
  performance: 'Performance',
  inquiry: 'Inquiry / Help',
};

export const CLOSE_CODES: CloseCode[] = [
  'Solution provided',
  'Workaround provided',
  'Resolved by change',
  'Resolved by caller',
  'Known error',
  'Duplicate',
  'No resolution provided',
  'User error',
];

export const CONTACT_TYPES: ContactType[] = [
  'monitoring',
  'phone',
  'email',
  'self_service',
  'chat',
  'walk_in',
];

export const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  monitoring: 'Monitoring',
  phone: 'Phone',
  email: 'Email',
  self_service: 'Self-service',
  chat: 'Chat',
  walk_in: 'Walk-in',
};

export const LINK_TYPES: LinkType[] = [
  'teams_channel',
  'merge_request',
  'alert',
  'log_query',
  'other',
];

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  teams_channel: 'Teams channel',
  merge_request: 'Merge request',
  alert: 'Alert',
  log_query: 'Log query',
  other: 'Link',
};

export const GROUP_TYPE_LABELS: Record<GroupType, string> = {
  app_support: 'Application support',
  noc: 'NOC',
  service_desk: 'Service desk',
  incident_management: 'Incident management',
  infrastructure: 'Infrastructure',
};

export const INCIDENT_RELATIONSHIPS: IncidentRelationship[] = ['parent', 'child', 'standalone'];

/**
 * Standard ServiceNow priority matrix: 1/1→P1; 1/2,2/1→P2; 1/3,2/2,3/1→P3; 2/3,3/2→P4; 3/3→P5.
 */
export function priorityFor(impact: ImpactUrgency, urgency: ImpactUrgency): Priority {
  return (impact + urgency - 1) as Priority;
}

export function isActiveState(state: IncidentState): boolean {
  return ACTIVE_STATES.includes(state);
}

/** Web UI links (see docs/ARCHITECTURE.md). */
export const serviceNowWebUrl = {
  incident: (number: string, base = URLS.servicenow.web) => `${base}/incidents/${number}`,
  app: (tla: string, base = URLS.servicenow.web) => `${base}/apps/${tla.toUpperCase()}`,
  group: (id: string, base = URLS.servicenow.web) => `${base}/groups/${id}`,
  user: (username: string, base = URLS.servicenow.web) => `${base}/users/${username}`,
  change: (number: string, base = URLS.servicenow.web) => `${base}/change_requests/${number}`,
  problem: (number: string, base = URLS.servicenow.web) => `${base}/problems/${number}`,
  communication: (number: string, base = URLS.servicenow.web) => `${base}/communications/${number}`,
};

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

export const CHANGE_STATES: ChangeState[] = ['new', 'scheduled', 'implement', 'closed', 'canceled'];

export const ACTIVE_CHANGE_STATES: ChangeState[] = ['new', 'scheduled', 'implement'];

export const CHANGE_STATE_LABELS: Record<ChangeState, string> = {
  new: 'New',
  scheduled: 'Scheduled',
  implement: 'Implement',
  closed: 'Closed',
  canceled: 'Canceled',
};

export const CHANGE_TYPES: ChangeType[] = ['normal', 'standard', 'emergency'];

export const CHANGE_TYPE_LABELS: Record<ChangeType, string> = {
  normal: 'Normal',
  standard: 'Standard',
  emergency: 'Emergency',
};

export const CHANGE_RISKS: ChangeRisk[] = ['low', 'moderate', 'high'];

export const CHANGE_RISK_LABELS: Record<ChangeRisk, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
};

export const CHANGE_CLOSE_CODE_LABELS: Record<ChangeCloseCode, string> = {
  successful: 'Successful',
  successful_with_issues: 'Successful with issues',
  unsuccessful: 'Unsuccessful',
};

export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  waiting: 'Waiting',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

export function isActiveChangeState(state: ChangeState): boolean {
  return ACTIVE_CHANGE_STATES.includes(state);
}

export const changeNumber = (n: number) => `CHG${String(n).padStart(7, '0')}`;

/**
 * Parses an MR reference: `keybank/PAY00/payments-api!12`, a GitLab MR web URL, or
 * `{ project, iid }`. Returns null when it is not recognisable.
 */
export function parseMergeRequestRef(
  input: string | { project: string; iid: number },
): { project: string; iid: number } | null {
  if (typeof input !== 'string') {
    const project = input.project?.trim().replace(/^\/+|\/+$/g, '');
    return project && Number.isInteger(input.iid) && input.iid > 0
      ? { project, iid: input.iid }
      : null;
  }
  const s = input.trim();
  const url = s.match(/([\w.-]+\/[\w.-]+\/[\w.-]+)\/-\/merge_requests\/(\d+)/);
  if (url) return { project: url[1]!, iid: Number(url[2]) };
  const ref = s.match(/^([\w.-]+\/[\w.-]+\/[\w.-]+)!(\d+)$/);
  if (ref) return { project: ref[1]!, iid: Number(ref[2]) };
  return null;
}

export const ACTIVITY_TABLES: ActivityTable[] = ['incident', 'change_request'];

export const ACTIVITY_KINDS: ActivityKind[] = [
  'incident.opened',
  'incident.updated',
  'incident.work_note',
  'incident.comment',
  'change_request.opened',
  'change_request.updated',
  'change_request.work_note',
  'change_request.comment',
];

// ---------------------------------------------------------------------------
// Resolution, problems and Critical Incident Communications
// ---------------------------------------------------------------------------

export const CAUSE_CODES: CauseCode[] = [
  'Change',
  'Software defect',
  'Configuration',
  'Capacity',
  'Hardware',
  'Network',
  'Data',
  'Vendor',
  'Human error',
  'Under investigation',
];

export const PROBLEM_STATES: ProblemState[] = [
  'open',
  'root_cause_analysis',
  'fix_in_progress',
  'resolved',
  'closed',
];

export const ACTIVE_PROBLEM_STATES: ProblemState[] = [
  'open',
  'root_cause_analysis',
  'fix_in_progress',
];

export const PROBLEM_STATE_LABELS: Record<ProblemState, string> = {
  open: 'Open',
  root_cause_analysis: 'Root Cause Analysis',
  fix_in_progress: 'Fix in Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const problemNumber = (n: number) => `PRB${String(n).padStart(7, '0')}`;

export const COMMUNICATION_KINDS: CommunicationKind[] = ['new', 'update', 'restored'];

export const COMMUNICATION_KIND_LABELS: Record<CommunicationKind, string> = {
  new: 'NEW',
  update: 'UPDATE',
  restored: 'RESTORED',
};

export const communicationNumber = (n: number) => `CIC${String(n).padStart(7, '0')}`;

/** The mailbox Critical Incident Communications are sent from. */
export const COMMUNICATION_FROM =
  'Critical Incident Communications <critical_incident_communications@keybank.example>';

/** Distribution group for a priority, e.g. `GRP_CIM_Tech_P1`. */
export const communicationGroup = (priority: number) => `GRP_CIM_Tech_P${priority}`;

/** The daily problem stand-up: 8:00 AM Eastern. */
export const STANDUP = { hour: 8, time_zone: 'America/New_York', label: '8:00 AM ET' } as const;
