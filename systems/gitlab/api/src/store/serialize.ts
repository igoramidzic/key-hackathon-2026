import type {
  Branch,
  Commit,
  CommitRef,
  GitlabEvent,
  GitlabUser,
  GitlabUserRole,
  Group,
  GroupDetail,
  MergeRequest,
  MergeRequestDetail,
  Note,
  Project,
  ProjectDetail,
  Tag,
  UserRef,
} from '@sim/contracts/gitlab';
import { getWorld, ORG, type Person, shaFor } from '@sim/world';
import { apiBase, web, webUrls } from '../urls';
import { diffStats } from './diff';
import type { GitlabStore, GroupInfo } from './store';
import type { BranchObj, CommitObj, EventObj, MrObj, NoteObj, RepoState, TagObj } from './types';

const iso = (ms: number) => new Date(ms).toISOString();

const USER_ROLES = new Set([
  'engineer',
  'manager',
  'support',
  'infra',
  'bot',
  'noc',
  'incident_manager',
]);

export function isGitlabUser(p: Person): boolean {
  return USER_ROLES.has(p.role);
}

function userId(p: Person | undefined, username: string): number {
  if (p) return Number(p.id.replace(/\D/g, '')) || 1;
  return 90_000 + (Number.parseInt(shaFor(username).slice(0, 6), 16) % 9_999);
}

export function userRef(username: string): UserRef {
  const p = getWorld().peopleByUsername.get(username);
  return {
    id: userId(p, username),
    username,
    name: p?.name ?? username,
    web_url: webUrls.user(username),
  };
}

export function userJson(store: GitlabStore, p: Person): GitlabUser {
  const role: GitlabUserRole = (
    ['engineer', 'manager', 'support', 'infra', 'bot'] as const
  ).includes(p.role as never)
    ? (p.role as GitlabUserRole)
    : 'other';
  return {
    ...userRef(p.username),
    email: p.email,
    state: 'active',
    bot: p.role === 'bot',
    role,
    job_title: p.title,
    groups: store.userTlas.get(p.username) ?? [],
  };
}

export function groupJson(g: GroupInfo): Group {
  return {
    id: g.id,
    name: g.name,
    path: g.path,
    full_path: g.fullPath,
    full_name: g.tla ? `${ORG.name} / ${g.name}` : ORG.name,
    description: g.description,
    parent_id: g.parentId,
    tla: g.tla,
    projects_count: g.projectIds.length,
    web_url: webUrls.group(g.fullPath),
  };
}

export function groupDetail(store: GitlabStore, g: GroupInfo): GroupDetail {
  const app = g.app;
  const members = app
    ? [
        { username: app.ownerUsername, level: 50 as const, name: 'Owner' },
        ...app.developerUsernames
          .filter((u) => u !== app.ownerUsername)
          .map((u, i) => ({
            username: u,
            level: (i === 0 ? 40 : 30) as 40 | 30,
            name: i === 0 ? 'Maintainer' : 'Developer',
          })),
      ]
    : [];
  return {
    ...groupJson(g),
    owner: app ? userRef(app.ownerUsername) : null,
    members: members.map((m) => ({
      ...userRef(m.username),
      access_level: m.level,
      access_level_name: m.name,
    })),
    subgroups_count: g.tla ? 0 : store.groups.length - 1,
  };
}

export function projectJson(store: GitlabStore, s: RepoState): Project {
  const repo = s.repo;
  const group = store.group(repo.tla);
  return {
    id: repo.id,
    name: repo.name,
    path: repo.name,
    path_with_namespace: repo.path,
    name_with_namespace: `${ORG.name} / ${repo.tla}00 / ${repo.name}`,
    description: repo.description,
    default_branch: repo.defaultBranch,
    tla: repo.tla,
    app_name: s.app.name,
    kind: repo.kind,
    stack: repo.stack,
    topics: [
      repo.tla.toLowerCase(),
      repo.stack,
      repo.kind,
      ...(s.app.hero ? ['core-banking'] : []),
    ],
    namespace: {
      id: group.id,
      name: group.name,
      path: group.path,
      full_path: group.fullPath,
      kind: 'group',
      web_url: webUrls.group(group.fullPath),
    },
    created_at: iso(s.createdAt),
    last_activity_at: iso(s.lastActivityAt),
    open_merge_requests_count: s.mrs.filter((m) => m.state === 'opened').length,
    http_url_to_repo: `${web()}/${repo.path}.git`,
    web_url: webUrls.project(repo.path),
  };
}

export function projectDetail(store: GitlabStore, s: RepoState): ProjectDetail {
  const head = s.branches.get(s.repo.defaultBranch)!.head;
  const history = store.history(s, head);
  const tree = store.tree(s, head);
  const readme = ['README.md', 'README', 'readme.md'].find((p) => tree.has(p)) ?? null;
  return {
    ...projectJson(store, s),
    last_commit: commitJson(s, history[0]!),
    branches_count: s.branches.size,
    tags_count: s.tags.size,
    commit_count: history.length,
    upstream_tlas: s.app.upstream,
    downstream_tlas: s.app.downstream,
    readme_path: readme,
  };
}

export function commitJson(
  s: RepoState,
  c: CommitObj,
  stats?: { additions: number; deletions: number; total: number },
): Commit {
  const p = getWorld().peopleByUsername.get(c.author);
  const name = p?.name ?? c.author;
  const email = p?.email ?? `${c.author}@${ORG.emailDomain}`;
  return {
    id: c.sha,
    short_id: c.sha.slice(0, 8),
    title: c.title,
    message: c.message,
    author_name: name,
    author_email: email,
    author_username: c.author,
    authored_date: iso(c.authoredAt),
    committer_name: name,
    committer_email: email,
    committed_date: iso(c.committedAt),
    created_at: iso(c.committedAt),
    parent_ids: c.parents,
    project_id: s.repo.id,
    project_path: s.repo.path,
    ...(stats ? { stats } : {}),
    merge_request_iid: c.mrIid,
    web_url: webUrls.commit(s.repo.path, c.sha),
  };
}

export function commitWithStats(store: GitlabStore, s: RepoState, c: CommitObj): Commit {
  return commitJson(s, c, diffStats(store.commitDiffs(s, c)));
}

export function commitRef(s: RepoState, c: CommitObj): CommitRef {
  return {
    id: c.sha,
    short_id: c.sha.slice(0, 8),
    title: c.title,
    author_username: c.author,
    created_at: iso(c.committedAt),
    web_url: webUrls.commit(s.repo.path, c.sha),
  };
}

export function branchJson(store: GitlabStore, s: RepoState, b: BranchObj): Branch {
  const mainHead = s.branches.get(s.repo.defaultBranch)!.head;
  const merged = b.name !== s.repo.defaultBranch && store.ancestors(s, mainHead).has(b.head);
  return {
    name: b.name,
    commit: commitJson(s, store.commit(s, b.head)),
    merged,
    protected: b.protected,
    default: b.name === s.repo.defaultBranch,
    web_url: webUrls.branch(s.repo.path, b.name),
  };
}

export function tagJson(store: GitlabStore, s: RepoState, t: TagObj): Tag {
  return {
    name: t.name,
    message: t.message,
    target: t.target,
    commit: commitJson(s, store.commit(s, t.target)),
    created_at: iso(t.createdAt),
    web_url: webUrls.tag(s.repo.path, t.name),
  };
}

export function mrJson(store: GitlabStore, s: RepoState, mr: MrObj): MergeRequest {
  const head = store.mrHead(mr);
  return {
    id: mr.id,
    iid: mr.iid,
    project_id: s.repo.id,
    project_path: s.repo.path,
    tla: s.repo.tla,
    title: mr.title,
    description: mr.description,
    state: mr.state,
    draft: /^(draft|wip)\b:?/i.test(mr.title),
    created_at: iso(mr.createdAt),
    updated_at: iso(mr.updatedAt),
    merged_at: mr.mergedAt ? iso(mr.mergedAt) : null,
    closed_at: mr.closedAt ? iso(mr.closedAt) : null,
    author: userRef(mr.author),
    merged_by: mr.mergedBy ? userRef(mr.mergedBy) : null,
    closed_by: mr.closedBy ? userRef(mr.closedBy) : null,
    approved_by: mr.approvedBy.map(userRef),
    source_branch: mr.sourceBranch,
    target_branch: mr.targetBranch,
    labels: mr.labels,
    sha: head,
    merge_commit_sha: mr.mergeCommitSha,
    pipeline: {
      id: mr.pipeline.id,
      status: store.pipelineStatus(mr),
      ref: `refs/merge-requests/${mr.iid}/head`,
      sha: head,
      web_url: webUrls.pipeline(s.repo.path, mr.pipeline.id),
    },
    user_notes_count: mr.notes.length,
    references: { short: `!${mr.iid}`, full: `${s.repo.path}!${mr.iid}` },
    web_url: webUrls.mr(s.repo.path, mr.iid),
  };
}

export function mrDetail(store: GitlabStore, s: RepoState, mr: MrObj): MergeRequestDetail {
  const diffs = store.mrDiffs(s, mr);
  const stats = diffStats(diffs);
  return {
    ...mrJson(store, s, mr),
    commits_count: mr.commits.length,
    changes_count: diffs.length,
    additions: stats.additions,
    deletions: stats.deletions,
    merge_status: store.mergeStatus(s, mr),
  };
}

export function noteJson(s: RepoState, mr: MrObj, n: NoteObj): Note {
  return {
    id: n.id,
    body: n.body,
    author: userRef(n.author),
    created_at: iso(n.createdAt),
    updated_at: iso(n.createdAt),
    system: n.system,
    noteable_type: 'MergeRequest',
    noteable_iid: mr.iid,
    project_id: s.repo.id,
  };
}

export function eventJson(store: GitlabStore, e: EventObj): GitlabEvent {
  const s = store.repos.get(e.repoId)!;
  const path = s.repo.path;
  let webUrl = webUrls.project(path);
  if (e.targetType === 'MergeRequest' && e.targetIid) webUrl = webUrls.mr(path, e.targetIid);
  else if (e.push?.refType === 'tag') webUrl = webUrls.tag(path, e.push.ref);
  else if (e.push) webUrl = webUrls.commit(path, e.push.to);
  return {
    id: e.id,
    action_name: e.action,
    target_type: e.targetType,
    target_iid: e.targetIid,
    target_title: e.targetTitle,
    created_at: iso(e.at),
    author: userRef(e.author),
    project_id: s.repo.id,
    project_path: path,
    project_name: s.repo.name,
    tla: s.repo.tla,
    push_data: e.push
      ? {
          ref: e.push.ref,
          ref_type: e.push.refType,
          commit_count: e.push.count,
          commit_to: e.push.to,
          commit_title: e.push.title,
        }
      : null,
    web_url: webUrl,
  };
}

export function archiveUrl(s: RepoState, ref: string) {
  return `${apiBase()}/api/v4/projects/${encodeURIComponent(s.repo.path)}/repository/archive?ref=${encodeURIComponent(ref)}&format=tar.gz`;
}
