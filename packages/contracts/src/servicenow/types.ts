/**
 * Cross-system ServiceNow types. The servicenow system owns this folder and adds its full API
 * types here; the shapes below are used by the simulator and must keep working.
 */

export type ContactType = 'phone' | 'email' | 'self_service' | 'monitoring' | 'chat' | 'walk_in';

/** 1 = High, 2 = Medium, 3 = Low (ServiceNow convention). */
export type ImpactUrgency = 1 | 2 | 3;

/** Body for `POST /api/incidents`. Users are usernames, groups are group ids or exact names. */
export interface IncidentCreateInput {
  short_description: string;
  description?: string;
  /** App TLA for the configuration item (cmdb_ci), if known. */
  app_tla?: string;
  caller?: string;
  opened_by?: string;
  contact_type?: ContactType;
  category?: string;
  subcategory?: string;
  impact?: ImpactUrgency;
  urgency?: ImpactUrgency;
  assignment_group?: string;
  assigned_to?: string;
}

/** Minimal incident shape the simulator reads back. */
export interface IncidentRef {
  sys_id: string;
  number: string;
  short_description: string;
  web_url: string;
}

// ---------------------------------------------------------------------------
// Incident model
// ---------------------------------------------------------------------------

/** Incident lifecycle. `new`, `in_progress` and `on_hold` are "active". */
export type IncidentState = 'new' | 'in_progress' | 'on_hold' | 'resolved' | 'closed' | 'canceled';

/** 1 = Critical, 2 = High, 3 = Moderate, 4 = Low, 5 = Planning. Derived from impact × urgency. */
export type Priority = 1 | 2 | 3 | 4 | 5;

export type IncidentCategory =
  | 'application'
  | 'network'
  | 'database'
  | 'access'
  | 'hardware'
  | 'batch_job'
  | 'performance'
  | 'inquiry';

export type CloseCode =
  | 'Solution provided'
  | 'Workaround provided'
  | 'Resolved by change'
  | 'Resolved by caller'
  | 'Known error'
  | 'Duplicate'
  | 'No resolution provided'
  | 'User error';

export type JournalType = 'work_note' | 'comment' | 'system';

export type LinkType = 'teams_channel' | 'merge_request' | 'alert' | 'log_query' | 'other';

export type IncidentSort =
  | 'opened_at'
  | '-opened_at'
  | 'updated_at'
  | '-updated_at'
  | 'priority'
  | '-priority'
  | 'number'
  | '-number';

// ---------------------------------------------------------------------------
// References (compact pointers embedded in other records)
// ---------------------------------------------------------------------------

export interface UserRef {
  username: string;
  name: string;
  email: string;
  web_url: string;
}

/** A person with the contact fields an on-call page needs. */
export interface Contact extends UserRef {
  title: string;
  phone: string;
}

export interface GroupRef {
  id: string;
  name: string;
  web_url: string;
}

export type AppTier = 1 | 2 | 3;

export interface AppRef {
  tla: string;
  name: string;
  tier: AppTier;
  web_url: string;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface FieldChange {
  /** API field name, e.g. `state`. */
  field: string;
  /** Display label, e.g. `State`. */
  label: string;
  from: string | null;
  to: string | null;
}

export interface JournalEntry {
  id: string;
  /** `work_note` (internal), `comment` (customer visible) or `system` (field changes). */
  type: JournalType;
  text: string;
  author: UserRef;
  created_at: string;
  /** Field changes recorded by a `system` entry. */
  changes?: FieldChange[];
}

export interface IncidentLinkInput {
  type: LinkType;
  url: string;
  title: string;
}

export interface IncidentLink extends IncidentLinkInput {
  id: string;
  added_by: UserRef;
  added_at: string;
}

export interface IncidentSummary extends IncidentRef {
  state: IncidentState;
  priority: Priority;
  impact: ImpactUrgency;
  urgency: ImpactUrgency;
  category: string;
  /** Configuration item (the affected application). */
  app: AppRef | null;
  assignment_group: GroupRef | null;
  assigned_to: UserRef | null;
  caller: UserRef | null;
  contact_type: ContactType;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
}

/** Full incident (`GET /api/incidents/:number`). A superset of `IncidentRef`. */
export interface Incident extends IncidentSummary {
  description: string;
  subcategory: string | null;
  opened_by: UserRef;
  updated_by: UserRef;
  resolved_by: UserRef | null;
  closed_at: string | null;
  close_code: CloseCode | null;
  close_notes: string | null;
  reassignment_count: number;
  reopen_count: number;
  links: IncidentLink[];
  /** Activity stream, oldest first. */
  journal: JournalEntry[];
}

export interface IncidentListQuery {
  /** One or more states. */
  state?: IncidentState[];
  priority?: Priority[];
  /** true = new/in_progress/on_hold, false = resolved/closed/canceled. */
  active?: boolean;
  app_tla?: string;
  /** Group id or exact name. */
  assignment_group?: string;
  /** Username, email or sys_id. Use `none` for unassigned. */
  assigned_to?: string;
  caller?: string;
  /** Free text over number, short description, description and app. */
  q?: string;
  /** ISO timestamp or relative (`24h`, `7d`). */
  opened_after?: string;
  sort?: IncidentSort;
  limit?: number;
  cursor?: string;
}

/** Body for `PATCH /api/incidents/:number`. Every field is optional. */
export interface IncidentUpdateInput {
  state?: IncidentState;
  impact?: ImpactUrgency;
  urgency?: ImpactUrgency;
  /** Group id or exact name; null clears it. */
  assignment_group?: string | null;
  /** Username, email or sys_id; null clears it. */
  assigned_to?: string | null;
  short_description?: string;
  description?: string;
  category?: string;
  subcategory?: string | null;
  app_tla?: string | null;
  caller?: string | null;
  contact_type?: ContactType;
  /** Required (with close_notes) when moving to `resolved` or `closed`. */
  close_code?: CloseCode;
  close_notes?: string;
  /** Adds an internal work note in the same update. */
  work_note?: string;
  /** Adds a customer-visible comment in the same update. */
  comment?: string;
  add_links?: IncidentLinkInput[];
  /** Who is making the change (username). Defaults to `svc_incident_auto`. */
  updated_by?: string;
}

/** Body for `POST /api/incidents/:number/journal`. */
export interface JournalInput {
  type: 'work_note' | 'comment';
  text: string;
  /** Username. Defaults to `svc_incident_auto`. */
  author?: string;
}

// ---------------------------------------------------------------------------
// CMDB: applications
// ---------------------------------------------------------------------------

export type Criticality =
  | 'Mission Critical'
  | 'Business Critical'
  | 'Business Operational'
  | 'Administrative';

export interface AppSummary extends AppRef {
  sys_id: string;
  description: string;
  criticality: Criticality;
  business_unit: string;
  support_group: GroupRef;
  owner: UserRef;
  upstream_count: number;
  downstream_count: number;
}

export interface AppRuntime {
  service: string;
  gcp_project: string;
  namespace: string;
  cluster: string;
  region: string;
}

export interface AppRepo {
  path: string;
  name: string;
  web_url: string;
}

export interface AppSupportGroup extends GroupRef {
  email: string;
  manager: Contact;
  on_call: { primary: Contact; secondary: Contact };
  members: Contact[];
}

export interface AppDetail extends Omit<AppSummary, 'support_group' | 'owner'> {
  lifecycle: string;
  stack: string;
  owner: Contact;
  support_group: AppSupportGroup;
  /** Apps this app calls (its dependencies). */
  upstream: AppRef[];
  /** Apps that call this app. */
  downstream: AppRef[];
  runtime: AppRuntime;
  repos: AppRepo[];
  /** `http://localhost:3003/keybank/<TLA>00` */
  gitlab_group_url: string;
  open_incident_count: number;
}

export interface AppListQuery {
  q?: string;
  tier?: AppTier;
  business_unit?: string;
  /** Group id or exact name. */
  support_group?: string;
  limit?: number;
  cursor?: string;
}

export type DependencyDirection = 'up' | 'down' | 'both';

export interface DependencyNode extends AppRef {
  criticality: Criticality;
  /** Hops from the root app. */
  depth: number;
  /** `up` = the root depends on it, `down` = it depends on the root. */
  direction: 'up' | 'down';
  support_group: GroupRef;
}

export interface DependencyEdge {
  /** The caller. */
  from: string;
  /** The app it calls (its dependency). */
  to: string;
}

export interface DependencyGraph {
  root: AppRef;
  direction: DependencyDirection;
  depth: number;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

// ---------------------------------------------------------------------------
// Groups and users
// ---------------------------------------------------------------------------

export type GroupType =
  | 'app_support'
  | 'noc'
  | 'service_desk'
  | 'incident_management'
  | 'infrastructure';

export interface GroupSummary extends GroupRef {
  sys_id: string;
  type: GroupType;
  description: string;
  email: string;
  manager: UserRef;
  on_call: { primary: UserRef; secondary: UserRef };
  member_count: number;
  app_count: number;
}

export interface GroupDetail extends Omit<GroupSummary, 'manager' | 'on_call'> {
  manager: Contact;
  on_call: { primary: Contact; secondary: Contact };
  members: Contact[];
  /** Applications this group supports (empty for shared groups such as the NOC). */
  apps: AppRef[];
  open_incident_count: number;
}

export interface GroupListQuery {
  q?: string;
  type?: GroupType;
  limit?: number;
  cursor?: string;
}

export interface UserSummary extends Contact {
  sys_id: string;
  department: string;
  location: string;
  role: string;
}

export interface UserGroupMembership extends GroupRef {
  type: GroupType;
  is_manager: boolean;
  is_member: boolean;
  on_call: 'primary' | 'secondary' | null;
}

export interface UserDetail extends UserSummary {
  timezone: string;
  manager: UserRef | null;
  groups: UserGroupMembership[];
  /** Apps supported by groups the user is a member of. */
  supported_apps: AppRef[];
  /** Apps the user owns (business/technical owner). */
  owned_apps: AppRef[];
  open_assigned_incident_count: number;
}

export interface UserListQuery {
  q?: string;
  /** Group id or exact name: only members of that group. */
  group?: string;
  role?: string;
  limit?: number;
  cursor?: string;
}
