import type { Health, Page, ResetResult } from '../common';
import { createHttp, type QueryValue, toQuery } from '../http';
import type {
  AdminCommitInput,
  AdminMergeInput,
  AdminMergeResult,
  Branch,
  Commit,
  CommitRef,
  CommitWithDiff,
  Compare,
  CreateBranchInput,
  CreateCommitInput,
  CreateMergeRequestInput,
  CreateNoteInput,
  CreateTagInput,
  FileDiff,
  GitlabEvent,
  GitlabUser,
  Group,
  GroupDetail,
  ListCommitsParams,
  ListEventsParams,
  ListGroupCommitsParams,
  ListGroupsParams,
  ListMergeRequestsParams,
  ListProjectsParams,
  ListUsersParams,
  MergeInput,
  MergeRequest,
  MergeRequestDetail,
  MergeRequestWithChanges,
  Note,
  PageParams,
  Project,
  ProjectDetail,
  RepoArchive,
  RepoFile,
  Tag,
  TreeEntry,
  TreeParams,
  UpdateMergeRequestInput,
} from './types';

/** URL-encodes a project path for use as `:id` (GitLab style): keybank%2FPAY00%2Fpayments-api */
export const encodeProject = (project: string | number) => encodeURIComponent(String(project));

/** Query objects with arrays/booleans → the flat query shape `createHttp` expects. */
const q = (params?: object) => (params ?? {}) as Record<string, QueryValue>;

/**
 * Typed client for the GitLab API. The gitlab system owns this file and adds methods; the ones
 * below are relied on by the simulator and must keep their signatures.
 *
 * `project` arguments accept the numeric id or the full path (`keybank/PAY00/payments-api`).
 */
export function createGitlabClient(baseUrl: string) {
  const http = createHttp(baseUrl);
  const p = (project: string | number) => `/api/v4/projects/${encodeProject(project)}`;
  const g = (group: string | number) => `/api/v4/groups/${encodeProject(group)}`;
  const mr = (project: string | number, iid: number) => `${p(project)}/merge_requests/${iid}`;
  const file = (project: string | number, path: string) =>
    `${p(project)}/repository/files/${encodeURIComponent(path)}`;

  return {
    http,
    health: () => http.get<Health>('/health'),
    reset: () => http.post<ResetResult>('/admin/reset'),
    adminMerge: (body: AdminMergeInput) => http.post<AdminMergeResult>('/admin/merge', body),
    adminCommit: (body: AdminCommitInput) => http.post<CommitRef>('/admin/commit', body),

    /**
     * `GET /api/v4/projects/:id/repository/files/:file_path/raw?ref=` — raw file text.
     * Returns null when the file does not exist.
     */
    getRawFile: async (project: string, path: string, ref = 'main'): Promise<string | null> => {
      const res = await fetch(
        `${baseUrl}/api/v4/projects/${encodeProject(project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getRawFile ${project}:${path} failed with ${res.status}`);
      return res.text();
    },

    // ----- users -----
    listUsers: (params?: ListUsersParams) => http.get<Page<GitlabUser>>('/api/v4/users', q(params)),
    getUser: (username: string) =>
      http.get<GitlabUser>(`/api/v4/users/${encodeURIComponent(username)}`),

    // ----- groups -----
    listGroups: (params?: ListGroupsParams) => http.get<Page<Group>>('/api/v4/groups', q(params)),
    getGroup: (group: string | number) => http.get<GroupDetail>(g(group)),
    listGroupProjects: (group: string | number, params?: ListProjectsParams) =>
      http.get<Page<Project>>(`${g(group)}/projects`, q(params)),
    listGroupMergeRequests: (group: string | number, params?: ListMergeRequestsParams) =>
      http.get<Page<MergeRequest>>(`${g(group)}/merge_requests`, q(params)),
    listGroupCommits: (group: string | number, params?: ListGroupCommitsParams) =>
      http.get<Page<Commit>>(`${g(group)}/commits`, q(params)),

    // ----- projects -----
    listProjects: (params?: ListProjectsParams) =>
      http.get<Page<Project>>('/api/v4/projects', q(params)),
    getProject: (project: string | number) => http.get<ProjectDetail>(p(project)),

    // ----- repository -----
    getTree: (project: string | number, params?: TreeParams) =>
      http.get<TreeEntry[]>(`${p(project)}/repository/tree`, q(params)),
    getFile: (project: string | number, path: string, ref = 'main') =>
      http.get<RepoFile>(file(project, path), { ref }),
    /** Every file at `ref` (the "clone" of the repository). */
    getArchive: (project: string | number, ref = 'main') =>
      http.get<RepoArchive>(`${p(project)}/repository/archive`, { ref, format: 'json' }),
    /** URL of the gzipped tarball for `ref` (absolute when the client has a base URL). */
    archiveUrl: (project: string | number, ref = 'main') =>
      `${baseUrl}${p(project)}/repository/archive${toQuery({ ref, format: 'tar.gz' })}`,
    listCommits: (project: string | number, params?: ListCommitsParams) =>
      http.get<Page<Commit>>(`${p(project)}/repository/commits`, q(params)),
    getCommit: (project: string | number, sha: string) =>
      http.get<CommitWithDiff>(`${p(project)}/repository/commits/${encodeURIComponent(sha)}`),
    getCommitDiff: (project: string | number, sha: string) =>
      http.get<FileDiff[]>(`${p(project)}/repository/commits/${encodeURIComponent(sha)}/diff`),
    getCommitMergeRequests: (project: string | number, sha: string) =>
      http.get<MergeRequest[]>(
        `${p(project)}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
      ),
    compare: (project: string | number, from: string, to: string) =>
      http.get<Compare>(`${p(project)}/repository/compare`, { from, to }),
    createCommit: (project: string | number, body: CreateCommitInput) =>
      http.post<Commit>(`${p(project)}/repository/commits`, body),
    listBranches: (project: string | number, params?: PageParams & { search?: string }) =>
      http.get<Page<Branch>>(`${p(project)}/repository/branches`, q(params)),
    getBranch: (project: string | number, branch: string) =>
      http.get<Branch>(`${p(project)}/repository/branches/${encodeURIComponent(branch)}`),
    createBranch: (project: string | number, body: CreateBranchInput) =>
      http.post<Branch>(`${p(project)}/repository/branches`, body),
    listTags: (project: string | number, params?: PageParams) =>
      http.get<Page<Tag>>(`${p(project)}/repository/tags`, q(params)),
    createTag: (project: string | number, body: CreateTagInput) =>
      http.post<Tag>(`${p(project)}/repository/tags`, body),

    // ----- merge requests -----
    listMergeRequests: (params?: ListMergeRequestsParams) =>
      http.get<Page<MergeRequest>>('/api/v4/merge_requests', q(params)),
    listProjectMergeRequests: (project: string | number, params?: ListMergeRequestsParams) =>
      http.get<Page<MergeRequest>>(`${p(project)}/merge_requests`, q(params)),
    getMergeRequest: (project: string | number, iid: number) =>
      http.get<MergeRequestDetail>(mr(project, iid)),
    getMergeRequestChanges: (project: string | number, iid: number) =>
      http.get<MergeRequestWithChanges>(`${mr(project, iid)}/changes`),
    getMergeRequestCommits: (project: string | number, iid: number) =>
      http.get<Commit[]>(`${mr(project, iid)}/commits`),
    createMergeRequest: (project: string | number, body: CreateMergeRequestInput) =>
      http.post<MergeRequestWithChanges>(`${p(project)}/merge_requests`, body),
    updateMergeRequest: (project: string | number, iid: number, body: UpdateMergeRequestInput) =>
      http.put<MergeRequestDetail>(mr(project, iid), body),
    mergeMergeRequest: (project: string | number, iid: number, body: MergeInput = {}) =>
      http.put<MergeRequestDetail>(`${mr(project, iid)}/merge`, body),
    /** Records `username` (default dwhitfield) as an approver of an open MR. */
    approveMergeRequest: (project: string | number, iid: number, username?: string) =>
      http.post<MergeRequestDetail>(`${mr(project, iid)}/approve`, { username }),
    listNotes: (project: string | number, iid: number) =>
      http.get<Note[]>(`${mr(project, iid)}/notes`),
    addNote: (project: string | number, iid: number, body: CreateNoteInput) =>
      http.post<Note>(`${mr(project, iid)}/notes`, body),

    // ----- activity -----
    listEvents: (params?: ListEventsParams) =>
      http.get<Page<GitlabEvent>>('/api/v4/events', q(params)),
  };
}

export type GitlabClient = ReturnType<typeof createGitlabClient>;
