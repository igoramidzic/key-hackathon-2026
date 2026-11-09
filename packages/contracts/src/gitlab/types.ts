/**
 * Cross-system GitLab types. The gitlab system owns this folder and adds its full API types
 * here; the shapes below are used by the simulator and must keep working.
 *
 * Projects live at `keybank/<TLA>00/<repo>` (e.g. `keybank/PAY00/payments-api`); the TLA is the
 * same three-letter application code used by ServiceNow. Wherever an endpoint takes a project
 * `:id`, it accepts the numeric id or the URL-encoded path (`keybank%2FPAY00%2Fpayments-api`).
 */

/**
 * One file change. Either give the full new `content`, or a `find`/`replace` pair applied to the
 * file's current content (the API fails with 422 if `find` is not found exactly once).
 * `content` on a path that does not exist creates the file.
 */
export interface FileEdit {
  path: string;
  content?: string;
  find?: string;
  replace?: string;
}

/**
 * `POST /admin/merge`: the simulator records an MR as opened by `author`, approved, and merged
 * by `merged_by` into the default branch right now. Returns the merged MR.
 */
export interface AdminMergeInput {
  project: string;
  title: string;
  description: string;
  author: string;
  merged_by: string;
  source_branch: string;
  labels?: string[];
  approvers?: string[];
  edits: FileEdit[];
  /** How long before the merge the MR was opened. Default 90. */
  opened_minutes_ago?: number;
  /** CI result shown on the MR. Default 'success'. */
  pipeline_status?: 'success' | 'failed';
}

/** `POST /admin/commit`: a direct commit to a branch (default: the default branch). */
export interface AdminCommitInput {
  project: string;
  message: string;
  author: string;
  edits: FileEdit[];
  branch?: string;
}

export interface CommitRef {
  id: string;
  short_id: string;
  title: string;
  author_username: string;
  created_at: string;
  web_url: string;
}

export interface AdminMergeResult {
  project: string;
  iid: number;
  web_url: string;
  merge_commit: CommitRef;
}

// ---------------------------------------------------------------------------
// Users, groups, projects
// ---------------------------------------------------------------------------

export type GitlabUserRole = 'engineer' | 'manager' | 'support' | 'infra' | 'bot' | 'other';

/** Compact user reference embedded in other entities. */
export interface UserRef {
  id: number;
  username: string;
  name: string;
  web_url: string;
}

export interface GitlabUser extends UserRef {
  email: string;
  state: 'active';
  bot: boolean;
  role: GitlabUserRole;
  job_title: string;
  /** TLAs of the groups this user is a member of. */
  groups: string[];
}

export interface GroupMember extends UserRef {
  access_level: 30 | 40 | 50;
  /** 'Developer' | 'Maintainer' | 'Owner' */
  access_level_name: string;
}

export interface Group {
  id: number;
  /** `PAY00` (or `keybank` for the root group). */
  name: string;
  path: string;
  /** `keybank/PAY00` */
  full_path: string;
  full_name: string;
  /** For app groups: the application name (matches the ServiceNow catalog). */
  description: string;
  parent_id: number | null;
  /** App TLA (null for the root group). */
  tla: string | null;
  projects_count: number;
  web_url: string;
}

export interface GroupDetail extends Group {
  owner: UserRef | null;
  members: GroupMember[];
  /** Root group only: number of subgroups. */
  subgroups_count: number;
}

export interface Namespace {
  id: number;
  name: string;
  path: string;
  full_path: string;
  kind: 'group';
  web_url: string;
}

export type ProjectKind = 'service' | 'web' | 'batch' | 'infra';
export type ProjectStack = 'java-spring' | 'node-ts' | 'python' | 'react-web' | 'terraform';

export interface Project {
  id: number;
  /** Repo name, e.g. `payments-api`. */
  name: string;
  path: string;
  /** `keybank/PAY00/payments-api` */
  path_with_namespace: string;
  name_with_namespace: string;
  description: string;
  default_branch: string;
  tla: string;
  app_name: string;
  kind: ProjectKind;
  stack: ProjectStack;
  topics: string[];
  namespace: Namespace;
  created_at: string;
  last_activity_at: string;
  open_merge_requests_count: number;
  http_url_to_repo: string;
  web_url: string;
}

export interface ProjectDetail extends Project {
  last_commit: Commit | null;
  branches_count: number;
  tags_count: number;
  commit_count: number;
  /** Upstream dependencies of the app (TLAs this app calls). */
  upstream_tlas: string[];
  downstream_tlas: string[];
  readme_path: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface Commit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  author_username: string;
  authored_date: string;
  committer_name: string;
  committer_email: string;
  committed_date: string;
  created_at: string;
  parent_ids: string[];
  project_id: number;
  project_path: string;
  /** Present on single-commit responses and when `with_stats=true`. */
  stats?: { additions: number; deletions: number; total: number };
  /** IID of the merge request this commit belongs to (source commit or merge commit). */
  merge_request_iid?: number | null;
  web_url: string;
}

export interface FileDiff {
  old_path: string;
  new_path: string;
  a_mode: string;
  b_mode: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  /** Unified diff hunks for this file (starts at the first `@@`). */
  diff: string;
  additions: number;
  deletions: number;
}

export interface CommitWithDiff extends Commit {
  stats: { additions: number; deletions: number; total: number };
  diffs: FileDiff[];
}

export interface TreeEntry {
  id: string;
  name: string;
  type: 'tree' | 'blob';
  path: string;
  mode: string;
}

export interface RepoFile {
  file_name: string;
  file_path: string;
  size: number;
  encoding: 'text';
  content: string;
  content_sha256: string;
  ref: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
  web_url: string;
}

export interface ArchiveFile {
  path: string;
  content: string;
}

/** `GET .../repository/archive?format=json`: every file at a ref. */
export interface RepoArchive {
  project: string;
  ref: string;
  sha: string;
  file_count: number;
  files: ArchiveFile[];
  /** Same archive as a gzipped tarball (`curl -s <url> | tar xz`). */
  archive_url: string;
}

export interface Branch {
  name: string;
  commit: Commit;
  merged: boolean;
  protected: boolean;
  default: boolean;
  web_url: string;
}

export interface Tag {
  name: string;
  message: string;
  target: string;
  commit: Commit;
  created_at: string;
  web_url: string;
}

export interface Compare {
  from: string;
  to: string;
  commit: Commit | null;
  commits: Commit[];
  diffs: FileDiff[];
  compare_same_ref: boolean;
  web_url: string;
}

export interface CommitAction {
  action: 'create' | 'update';
  file_path: string;
  content: string;
}

/** `POST .../repository/commits` (GitLab style). */
export interface CreateCommitInput {
  branch: string;
  /** Create `branch` from this ref if it does not exist yet. */
  start_branch?: string;
  commit_message: string;
  /** Username. Default: svc_incident_auto. */
  author?: string;
  actions: CommitAction[];
}

export interface CreateBranchInput {
  branch: string;
  ref: string;
}

export interface CreateTagInput {
  tag_name: string;
  ref: string;
  message?: string;
  author?: string;
}

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

export type MergeRequestState = 'opened' | 'closed' | 'merged';
export type PipelineStatus = 'success' | 'failed' | 'running' | 'pending' | 'canceled';

export interface PipelineRef {
  id: number;
  status: PipelineStatus;
  ref: string;
  sha: string;
  web_url: string;
}

export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  project_path: string;
  tla: string;
  title: string;
  description: string;
  state: MergeRequestState;
  draft: boolean;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  author: UserRef;
  merged_by: UserRef | null;
  closed_by: UserRef | null;
  approved_by: UserRef[];
  source_branch: string;
  target_branch: string;
  labels: string[];
  /** Head commit of the source branch. */
  sha: string;
  merge_commit_sha: string | null;
  pipeline: PipelineRef;
  user_notes_count: number;
  /** `!12` and `keybank/PAY00/payments-api!12` */
  references: { short: string; full: string };
  web_url: string;
}

export interface MergeRequestDetail extends MergeRequest {
  commits_count: number;
  changes_count: number;
  additions: number;
  deletions: number;
  merge_status: 'can_be_merged' | 'cannot_be_merged' | 'merged' | 'closed';
}

export interface MergeRequestWithChanges extends MergeRequestDetail {
  changes: FileDiff[];
}

export interface CreateMergeRequestInput {
  source_branch: string;
  /** Default: the project's default branch (main). */
  target_branch?: string;
  title: string;
  description?: string;
  labels?: string[] | string;
  /** Username. Default: svc_incident_auto. */
  author?: string;
  /**
   * Optional file edits. When given, the API creates `source_branch` from `target_branch` (if it
   * does not exist) and commits the edits to it before opening the MR.
   */
  changes?: FileEdit[];
  /** Commit message for `changes`. Default: the MR title. */
  commit_message?: string;
}

export interface UpdateMergeRequestInput {
  title?: string;
  description?: string;
  /** Replaces all labels. */
  labels?: string[] | string;
  add_labels?: string[] | string;
  remove_labels?: string[] | string;
  state_event?: 'close' | 'reopen';
  /** Username performing the update (for close/reopen). Default: svc_incident_auto. */
  actor?: string;
}

export interface MergeInput {
  /** Username. Default: dwhitfield. */
  merged_by?: string;
  merge_commit_message?: string;
}

export interface Note {
  id: number;
  body: string;
  author: UserRef;
  created_at: string;
  updated_at: string;
  system: boolean;
  noteable_type: 'MergeRequest';
  noteable_iid: number;
  project_id: number;
}

export interface CreateNoteInput {
  body: string;
  /** Username. Default: svc_incident_auto. */
  author?: string;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type EventAction =
  | 'pushed to'
  | 'pushed new'
  | 'opened'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'commented on'
  | 'created';

export interface GitlabEvent {
  id: number;
  action_name: EventAction;
  target_type: 'MergeRequest' | 'Note' | 'Tag' | null;
  target_iid: number | null;
  target_title: string | null;
  created_at: string;
  author: UserRef;
  project_id: number;
  project_path: string;
  project_name: string;
  tla: string;
  push_data: {
    ref: string;
    ref_type: 'branch' | 'tag';
    commit_count: number;
    commit_to: string;
    commit_title: string;
  } | null;
  web_url: string;
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export interface PageParams {
  limit?: number;
  cursor?: string;
}

export interface ListGroupsParams extends PageParams {
  search?: string;
}

export interface ListProjectsParams extends PageParams {
  search?: string;
  tla?: string;
  stack?: ProjectStack;
  kind?: ProjectKind;
  order_by?: 'last_activity_at' | 'name' | 'id' | 'created_at';
  sort?: 'asc' | 'desc';
}

export interface ListCommitsParams extends PageParams {
  ref_name?: string;
  /** ISO time or relative (`24h`, `7d`). */
  since?: string;
  until?: string;
  author?: string;
  path?: string;
  with_stats?: boolean;
  /** Only commits on the first-parent (mainline) history. */
  first_parent?: boolean;
}

export interface ListGroupCommitsParams extends PageParams {
  since?: string;
  until?: string;
  author?: string;
  ref_name?: string;
}

export interface ListMergeRequestsParams extends PageParams {
  state?: MergeRequestState | 'all';
  tla?: string;
  /** Comma separated or array; MRs must have all of them. */
  labels?: string[] | string;
  author?: string;
  merged_after?: string;
  merged_before?: string;
  updated_after?: string;
  created_after?: string;
  search?: string;
  order_by?: 'created_at' | 'updated_at' | 'merged_at';
  sort?: 'asc' | 'desc';
}

export interface ListEventsParams extends PageParams {
  since?: string;
  tla?: string;
  project?: string;
  author?: string;
  action?: EventAction | 'pushed' | 'merged' | 'opened';
}

export interface ListUsersParams extends PageParams {
  search?: string;
  /** Members of this app group. */
  tla?: string;
}

export interface TreeParams {
  path?: string;
  ref?: string;
  recursive?: boolean;
}
