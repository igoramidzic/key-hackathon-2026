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
  /** Make the new incident a child of this (active) parent incident. */
  parent_incident?: string;
  /** Existing incidents to attach as children of the new incident (it becomes their parent). */
  child_incidents?: string[];
  /** Other applications (TLAs) the incident affects, besides the configuration item. */
  affected_cis?: string[];
  /** When the service started to degrade (ISO or relative). */
  outage_start?: string;
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

/** What caused the incident (Resolution section of an incident, and problems). */
export type CauseCode =
  | 'Change'
  | 'Software defect'
  | 'Configuration'
  | 'Capacity'
  | 'Hardware'
  | 'Network'
  | 'Data'
  | 'Vendor'
  | 'Human error'
  | 'Under investigation';

export type JournalType = 'work_note' | 'comment' | 'system';

export type LinkType = 'teams_channel' | 'merge_request' | 'alert' | 'log_query' | 'other';

/** `parent` = has child incidents, `child` = has a parent, `standalone` = neither. */
export type IncidentRelationship = 'parent' | 'child' | 'standalone';

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
  /** Number of the parent incident, when this incident is a child. */
  parent_incident: string | null;
  /** How many child incidents roll up to this one. */
  child_count: number;
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
  /** Other applications affected (the "Affected CIs" list), besides `app`. */
  affected_cis: AppRef[];
  // Resolution section: filled in as the incident is worked and required reading once resolved.
  /** When the service started to degrade. */
  outage_start: string | null;
  /** When the service was confirmed back to normal. */
  service_restored_at: string | null;
  /** Minutes from `outage_start` to `service_restored_at`, when both are set. */
  outage_duration_minutes: number | null;
  cause_code: CauseCode | null;
  /** The change request that caused the incident (CHG number). */
  caused_by_change: string | null;
  /** The change request that fixed it (CHG number). */
  resolved_by_change: string | null;
  root_cause: string | null;
  /** Impact to clients, in plain business language. */
  client_impact: string | null;
  /** Impact to employees, in plain business language. */
  employee_impact: string | null;
  /** Problem record that investigates this incident (PRB number). */
  problem: string | null;
  /** Critical Incident Communications drafted or sent for this incident, oldest first. */
  communications: CommunicationSummary[];
  reassignment_count: number;
  reopen_count: number;
  links: IncidentLink[];
  /** Incidents that roll up to this one (it is their parent), oldest first. */
  child_incidents: IncidentSummary[];
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
  /** How it was reported, e.g. `phone`. */
  contact_type?: ContactType[];
  category?: string;
  /** Only children of this incident. */
  parent_incident?: string;
  relationship?: IncidentRelationship;
  /** Free text over number, short description, description, app and caller. */
  q?: string;
  /** ISO timestamp or relative (`24h`, `7d`). */
  opened_after?: string;
  opened_before?: string;
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
  /** Parent incident number; null detaches the incident from its parent. */
  parent_incident?: string | null;
  /** Required (with close_notes) when moving to `resolved` or `closed`. */
  close_code?: CloseCode;
  close_notes?: string;
  /** Replaces the Affected CIs list (TLAs). */
  affected_cis?: string[];
  /** ISO or relative time; null clears it. */
  outage_start?: string | null;
  service_restored_at?: string | null;
  cause_code?: CauseCode | null;
  /** CHG number; null clears it. */
  caused_by_change?: string | null;
  resolved_by_change?: string | null;
  root_cause?: string | null;
  client_impact?: string | null;
  employee_impact?: string | null;
  /** Adds an internal work note in the same update. */
  work_note?: string;
  /** Adds a customer-visible comment in the same update. */
  comment?: string;
  add_links?: IncidentLinkInput[];
  /** Who is making the change (username). Defaults to `svc_incident_auto`. */
  updated_by?: string;
}

/** Body for `POST /api/incidents/:number/children`: attach incidents to a parent. */
export interface LinkChildrenInput {
  /** Incident numbers to attach. Already-attached ones are ignored. */
  children: string[];
  /** Internal note added to the parent. */
  work_note?: string;
  /** Caller-visible comment added to each newly attached child. */
  child_comment?: string;
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

// ---------------------------------------------------------------------------
// Change requests (CHG) and KBR (KeyBank Release)
// ---------------------------------------------------------------------------

/**
 * Nothing reaches production by merging. Merging to `main` deploys to QV; a change request
 * promotes merged MRs from QV to production. KBR picks up every `scheduled` change once its
 * planned start passes, deploys the merge commits and closes the change.
 *
 * - `new`: draft, no planned start yet (or a KBR run aborted and it needs rescheduling)
 * - `scheduled`: approved and waiting for its planned start
 * - `implement`: KBR is promoting it right now
 * - `closed`: done (see `close_code`)
 * - `canceled`: withdrawn before KBR ran
 */
export type ChangeState = 'new' | 'scheduled' | 'implement' | 'closed' | 'canceled';

/** `normal` goes through CAB, `standard` is pre-approved, `emergency` fixes a live incident. */
export type ChangeType = 'normal' | 'standard' | 'emergency';

export type ChangeRisk = 'low' | 'moderate' | 'high';

export type ChangeCloseCode = 'successful' | 'successful_with_issues' | 'unsuccessful';

export type ReleaseStatus = 'waiting' | 'running' | 'succeeded' | 'failed';

/**
 * A merge request on a change: `keybank/CIF00/customer-profile-api!42`, its GitLab web URL, or
 * `{ project, iid }`.
 */
export type ChangeMergeRequestInput = string | { project: string; iid: number };

export interface ChangeMergeRequest {
  project: string;
  iid: number;
  /** `keybank/CIF00/customer-profile-api!42` */
  reference: string;
  web_url: string;
  /** Filled in by KBR when it validates the change. */
  title: string | null;
  /** GitLab state when KBR last looked (`merged` is required to promote). */
  state: string | null;
  merge_commit_sha: string | null;
}

/** What KBR rolled out to production for one GitLab project. */
export interface ChangeDeployment {
  project: string;
  app_tla: string;
  /** k8s deployment (service) that was rolled; null for repos that are not deployed (web, infra). */
  service: string | null;
  sha: string;
  short_sha: string;
  /** Running version after the rollout, e.g. `2.14.8-3f9c2ab`. */
  version: string | null;
  /** GitLab tag KBR created at the promoted commit. */
  tag: string | null;
  deployed_at: string;
}

export interface ChangeRelease {
  /** KBR release id, e.g. `KBR-20261111-0042`. */
  id: string | null;
  status: ReleaseStatus;
  started_at: string | null;
  finished_at: string | null;
}

export interface ChangeRequestSummary {
  sys_id: string;
  number: string;
  short_description: string;
  type: ChangeType;
  state: ChangeState;
  risk: ChangeRisk;
  /** Configuration item: the application being changed. */
  app: AppRef;
  /** GitLab projects touched (from the merge requests). */
  projects: string[];
  merge_request_count: number;
  requested_by: UserRef;
  assignment_group: GroupRef | null;
  /** When KBR promotes it. */
  planned_start: string | null;
  implemented_at: string | null;
  close_code: ChangeCloseCode | null;
  release: ChangeRelease;
  /** Incidents this change fixes or relates to. */
  related_incidents: string[];
  opened_at: string;
  updated_at: string;
  web_url: string;
}

/** Full change request (`GET /api/change_requests/:number`). */
export interface ChangeRequest extends ChangeRequestSummary {
  description: string;
  justification: string;
  backout_plan: string;
  merge_requests: ChangeMergeRequest[];
  deployments: ChangeDeployment[];
  close_notes: string | null;
  opened_by: UserRef;
  updated_by: UserRef;
  /** Activity stream, oldest first. */
  journal: JournalEntry[];
}

/** Body for `POST /api/change_requests`. */
export interface ChangeCreateInput {
  short_description: string;
  /** Application TLA (the project's group, keybank/<TLA>00). */
  app_tla: string;
  /** Merge requests to promote together. Each must be in the app's GitLab group. */
  merge_requests: ChangeMergeRequestInput[];
  /**
   * When KBR promotes it: ISO time, `now`, or a relative offset like `+30m`, `in 2h`. Omit to
   * leave the change in `new` (draft).
   */
  planned_start?: string;
  type?: ChangeType;
  risk?: ChangeRisk;
  description?: string;
  justification?: string;
  backout_plan?: string;
  requested_by?: string;
  assignment_group?: string;
  related_incidents?: string[];
}

export interface ChangeUpdateInput {
  /** `scheduled` needs a planned start; `canceled` withdraws it. `implement`/`closed` are KBR's. */
  state?: 'new' | 'scheduled' | 'canceled';
  planned_start?: string;
  short_description?: string;
  description?: string;
  type?: ChangeType;
  risk?: ChangeRisk;
  add_merge_requests?: ChangeMergeRequestInput[];
  related_incidents?: string[];
  work_note?: string;
  updated_by?: string;
}

export type ChangeSort =
  | 'planned_start'
  | '-planned_start'
  | 'opened_at'
  | '-opened_at'
  | 'implemented_at'
  | '-implemented_at'
  | 'number'
  | '-number';

export interface ChangeListQuery {
  state?: ChangeState[];
  type?: ChangeType[];
  /** true = new/scheduled/implement. */
  active?: boolean;
  app_tla?: string;
  /** GitLab project path; matches changes that include an MR from it. */
  project?: string;
  /** An MR reference or URL; matches changes that include it. */
  merge_request?: string;
  requested_by?: string;
  related_incident?: string;
  q?: string;
  /** ISO or relative ("6h"). */
  implemented_after?: string;
  implemented_before?: string;
  planned_after?: string;
  planned_before?: string;
  sort?: ChangeSort;
  limit?: number;
  cursor?: string;
}

/** `POST /admin/change_requests/:number/release` (the simulator's KBR only). */
export interface ChangeReleaseInput {
  status: 'running' | 'succeeded' | 'failed';
  release_id?: string;
  /** Resolved MR details (title, state, merge commit). */
  merge_requests?: ChangeMergeRequest[];
  deployments?: ChangeDeployment[];
  note?: string;
}

/** `POST /admin/change_requests` (the simulator's history backfill and scenario setup). */
export interface ChangeImportInput {
  short_description: string;
  app_tla: string;
  merge_requests: ChangeMergeRequest[];
  type?: ChangeType;
  risk?: ChangeRisk;
  state: 'scheduled' | 'closed';
  description?: string;
  requested_by: string;
  opened_at: string;
  planned_start: string;
  /** For closed changes. */
  release_id?: string;
  deployments?: ChangeDeployment[];
}

// ---------------------------------------------------------------------------
// Problems (PRB): the record behind the daily 8:00 AM problem stand-up
// ---------------------------------------------------------------------------

/**
 * A problem investigates one or more incidents after service is back: what happened, why, and
 * what stops it happening again. New problems go on the agenda of the next daily problem
 * stand-up (8:00 AM Eastern), where incidents that hit operations or customers are reviewed.
 */
export type ProblemState =
  | 'open'
  | 'root_cause_analysis'
  | 'fix_in_progress'
  | 'resolved'
  | 'closed';

export interface ProblemSummary {
  sys_id: string;
  number: string;
  short_description: string;
  state: ProblemState;
  priority: Priority;
  /** Highest priority among the incidents it investigates. */
  incident_priority: Priority | null;
  /** Configuration item. */
  app: AppRef | null;
  cause_code: CauseCode;
  /** The same failure keeps coming back. */
  chronic: boolean;
  /** Opened before any incident happened. */
  proactive: boolean;
  assignment_group: GroupRef | null;
  assigned_to: UserRef | null;
  problem_coordinator: UserRef | null;
  /** Incident numbers this problem investigates. */
  incidents: string[];
  /** Date (YYYY-MM-DD, Eastern) of the 8:00 AM stand-up it is on the agenda for; null = not on one. */
  standup_date: string | null;
  opened_at: string;
  updated_at: string;
  web_url: string;
}

/** Full problem (`GET /api/problems/:number`). */
export interface Problem extends ProblemSummary {
  description: string;
  root_cause: string | null;
  workaround: string | null;
  /** "Mitigation/Repair Plan": what was done, and what is left to do. */
  mitigation_plan: string | null;
  action_items: string | null;
  /** The change that fixed it (CHG number). */
  change_request: string | null;
  /** The change that caused it (CHG number). */
  caused_by_change: string | null;
  vendor: string | null;
  /** Impact to clients / employees, copied to the stand-up agenda. */
  client_impact: string | null;
  employee_impact: string | null;
  opened_by: UserRef;
  updated_by: UserRef;
  /** The incidents it investigates, oldest first. */
  related_incidents: IncidentSummary[];
  journal: JournalEntry[];
}

/** Body for `POST /api/problems`. */
export interface ProblemCreateInput {
  short_description: string;
  description?: string;
  app_tla?: string;
  /** Incidents this problem investigates; each gets `problem` set. */
  incidents?: string[];
  /** Defaults to the highest priority among `incidents`, else 3. */
  priority?: Priority;
  /** Defaults to `Under investigation`. */
  cause_code?: CauseCode;
  root_cause?: string;
  workaround?: string;
  mitigation_plan?: string;
  action_items?: string;
  change_request?: string;
  caused_by_change?: string;
  vendor?: string;
  client_impact?: string;
  employee_impact?: string;
  chronic?: boolean;
  proactive?: boolean;
  /** Defaults to the app's support group. */
  assignment_group?: string;
  assigned_to?: string;
  /** Defaults to the Major Incident Management on-call. */
  problem_coordinator?: string;
  /** Put it on the next 8:00 AM stand-up (default true). */
  standup?: boolean;
  opened_by?: string;
}

export interface ProblemUpdateInput {
  state?: ProblemState;
  short_description?: string;
  description?: string;
  priority?: Priority;
  cause_code?: CauseCode;
  root_cause?: string | null;
  workaround?: string | null;
  mitigation_plan?: string | null;
  action_items?: string | null;
  change_request?: string | null;
  caused_by_change?: string | null;
  vendor?: string | null;
  client_impact?: string | null;
  employee_impact?: string | null;
  chronic?: boolean;
  proactive?: boolean;
  assignment_group?: string | null;
  assigned_to?: string | null;
  problem_coordinator?: string | null;
  /** More incidents to investigate. */
  add_incidents?: string[];
  /** true = next stand-up, false = take it off the agenda. */
  standup?: boolean;
  work_note?: string;
  updated_by?: string;
}

export interface ProblemListQuery {
  state?: ProblemState[];
  /** true = not resolved or closed. */
  active?: boolean;
  app_tla?: string;
  /** Problems that investigate this incident. */
  incident?: string;
  /** `next` (the upcoming 8:00 AM stand-up), `today`, or a YYYY-MM-DD date. */
  standup?: string;
  q?: string;
  opened_after?: string;
  limit?: number;
  cursor?: string;
}

/** `GET /api/problems/standup`: the agenda of one daily problem stand-up. */
export interface ProblemStandup {
  /** YYYY-MM-DD (Eastern). */
  date: string;
  /** ISO time of the call (8:00 AM Eastern on `date`). */
  starts_at: string;
  problems: Problem[];
}

// ---------------------------------------------------------------------------
// Critical Incident Communications (CIC): the email to the internal distribution groups
// ---------------------------------------------------------------------------

/**
 * `new` announces an active incident, `update` follows up, `restored` says service is back.
 * A `restored` communication with no earlier one sent is titled NEW/RESTORED.
 */
export type CommunicationKind = 'new' | 'update' | 'restored';

/** Drafts are written by automation or the Communication Specialist; a person sends them. */
export type CommunicationState = 'draft' | 'sent';

export interface CommunicationSummary {
  /** e.g. `CIC0050001`. */
  number: string;
  /** Incident number. */
  incident: string;
  kind: CommunicationKind;
  state: CommunicationState;
  /** e.g. `<page> NEW - INC0010234 - Customer profile lookups failing`. */
  subject: string;
  /** Distribution group, e.g. `GRP_CIM_Tech_P1`. */
  to: string;
  priority: Priority;
  drafted_at: string;
  updated_at: string;
  sent_at: string | null;
  web_url: string;
}

/** Full communication (`GET /api/communications/:number`): everything the email shows. */
export interface Communication extends CommunicationSummary {
  from: string;
  /** Headline after the incident number in the subject. */
  title: string;
  /** When the incident started. */
  start: string;
  /** When service was restored (`restored` only). */
  resolved: string | null;
  duration_minutes: number | null;
  systems_impacted: AppRef[];
  description: string;
  client_impact: string | null;
  employee_impact: string | null;
  cause: string | null;
  resolution_activities: string | null;
  incident_manager: UserRef | null;
  communication_specialist: UserRef | null;
  technology_owners: UserRef[];
  drafted_by: UserRef;
  sent_by: UserRef | null;
}

/**
 * Body for `POST /api/incidents/:number/communications`. Drafting the same `kind` again for an
 * incident replaces the unsent draft instead of adding a second one.
 */
export interface CommunicationDraftInput {
  kind: CommunicationKind;
  /** Headline; defaults to the incident's short description. */
  title?: string;
  description: string;
  /** TLAs; defaults to the incident's app and affected CIs. */
  systems_impacted?: string[];
  /** Defaults to the incident's outage start, else when it was opened. */
  start?: string;
  /** `restored`: defaults to the incident's service-restored time, else now. */
  resolved?: string;
  client_impact?: string;
  employee_impact?: string;
  cause?: string;
  resolution_activities?: string;
  /** Defaults to the Major Incident Management on-call (primary). */
  incident_manager?: string;
  /** Defaults to the Major Incident Management on-call (secondary). */
  communication_specialist?: string;
  /** Usernames; defaults to the owner of the incident's application. */
  technology_owners?: string[];
  /** Defaults to `GRP_CIM_Tech_P<priority>`. */
  to?: string;
  drafted_by?: string;
}

/** Body for `POST /api/communications/:number/send` (the web UI: a person sends, never a tool). */
export interface CommunicationSendInput {
  sent_by?: string;
}

export interface CommunicationListQuery {
  incident?: string;
  state?: CommunicationState;
  kind?: CommunicationKind;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Activity feed (`GET /api/activity/tail`, `GET /api/activity/stream`)
// ---------------------------------------------------------------------------

export type ActivityTable = 'incident' | 'change_request';

/**
 * What a journal entry means: `opened` (the record's first entry), `updated` (other system
 * entries with field changes), `work_note` or `comment`.
 */
export type ActivityKind =
  | 'incident.opened'
  | 'incident.updated'
  | 'incident.work_note'
  | 'incident.comment'
  | 'change_request.opened'
  | 'change_request.updated'
  | 'change_request.work_note'
  | 'change_request.comment';

/**
 * One journal entry on an incident or change request, in the order ServiceNow recorded it.
 * `seq` is monotonic across both tables until the API is reset.
 */
export interface ActivityEvent {
  seq: number;
  kind: ActivityKind;
  table: ActivityTable;
  /** INC… or CHG… number. */
  number: string;
  /** TLA of the record's application, when it has one. */
  app_tla: string | null;
  /** When the entry was recorded (imported history can be in the past). */
  at: string;
  entry: JournalEntry;
  /** The incident as it is now (not as it was at `seq`), for `table: "incident"`. */
  incident?: IncidentSummary;
  /** The change request as it is now, for `table: "change_request"`. */
  change_request?: ChangeRequestSummary;
}

export interface ActivityFilterQuery {
  /** Comma-separated: `incident`, `change_request`. */
  table?: string;
  /** Comma-separated kinds, e.g. `incident.opened,incident.comment`. */
  kind?: string;
  /** Comma-separated TLAs. */
  app_tla?: string;
  /** Comma-separated incident contact types, e.g. `phone,email` (incidents only). */
  contact_type?: string;
}

export interface ActivityTailQuery extends ActivityFilterQuery {
  /** Return events with seq > after_seq (0 replays everything). Omit to get the latest `limit`. */
  after_seq?: number;
  /** When nothing new matches yet, wait up to this many seconds (0-30). */
  wait_seconds?: number;
  /** 1-500, default 50. */
  limit?: number;
}

export interface ActivityTailResult {
  /** Matching events in seq order. */
  items: ActivityEvent[];
  /** Pass as `after_seq` on the next call. */
  cursor: number;
  last_seq: number;
  /** Changes when the API is reset (seq restarts): drop local state and restart from 0. */
  epoch: number;
  /** True when more matching events are already available after `cursor`. */
  has_more: boolean;
}

/** Query for `GET /api/activity/stream` (Server-Sent Events). */
export interface ActivityStreamQuery extends ActivityFilterQuery {
  /** Replay matching events with seq > after_seq first. `Last-Event-ID` takes precedence. */
  after_seq?: number;
}
