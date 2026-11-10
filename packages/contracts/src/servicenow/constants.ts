import { URLS } from '../config';
import type {
  CloseCode,
  ContactType,
  GroupType,
  ImpactUrgency,
  IncidentCategory,
  IncidentRelationship,
  IncidentState,
  LinkType,
  Priority,
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
};
