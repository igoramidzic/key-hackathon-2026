import { URLS } from '@sim/contracts';
import {
  type Commit,
  createGitlabClient,
  type FileDiff,
  type MergeRequest,
  type Project,
} from '@sim/contracts/gitlab';
import {
  defineTool,
  IDEMPOTENT_WRITE,
  type McpServer,
  type McpServerSpec,
  paginationShape,
  READ_ONLY,
  WRITE,
} from '@sim/mcp-kit';
import { z } from 'zod';

export const api = createGitlabClient(process.env.GITLAB_API_URL ?? URLS.gitlab.api);

const PROJECT_FORMAT =
  'Projects live at keybank/<TLA>00/<repo>, e.g. keybank/PAY00/payments-api. The TLA is the three-letter application code used in ServiceNow (cmdb_ci) and in log/alert payloads, so an app TLA from an incident maps directly to its GitLab group keybank/<TLA>00.';

const project = z
  .string()
  .min(1)
  .describe(
    'Project path keybank/<TLA>00/<repo> (e.g. "keybank/CIF00/customer-profile-api") or numeric project id.',
  );
const tla = z
  .string()
  .min(3)
  .max(3)
  .describe(
    'Application TLA as used in ServiceNow, e.g. "CIF". Covers every repo in group keybank/<TLA>00.',
  );
const ref = z
  .string()
  .optional()
  .describe('Branch, tag or commit sha (full or short). Default: main.');
const since = z
  .string()
  .optional()
  .describe('Lower time bound: relative ("30m", "6h", "2d") or ISO 8601 ("2026-11-09T14:00:00Z").');

const fileEdit = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('Repo-relative file path, e.g. "src/main/resources/application.yml".'),
    content: z
      .string()
      .optional()
      .describe(
        'Full new file content. Creates the file if it does not exist. Omit when using find/replace.',
      ),
    find: z
      .string()
      .optional()
      .describe(
        'Exact text to replace in the current file. Must occur exactly once (include surrounding lines to make it unique), otherwise the call fails with 422.',
      ),
    replace: z.string().optional().describe('Replacement text for `find` (default: empty string).'),
  })
  .describe('One file change: either full `content`, or a `find`/`replace` pair.');

const labels = z.array(z.string()).optional().describe('Labels, e.g. ["incident", "bug"].');

// ---------------------------------------------------------------------------
// Compact shapes for list results
// ---------------------------------------------------------------------------

const compactProject = (p: Project) => ({
  path: p.path_with_namespace,
  id: p.id,
  tla: p.tla,
  app_name: p.app_name,
  kind: p.kind,
  stack: p.stack,
  description: p.description,
  last_activity_at: p.last_activity_at,
  open_merge_requests: p.open_merge_requests_count,
  web_url: p.web_url,
});

const compactCommit = (c: Commit) => ({
  sha: c.id,
  short_id: c.short_id,
  project: c.project_path,
  title: c.title,
  author: c.author_username,
  created_at: c.created_at,
  merge_request_iid: c.merge_request_iid ?? null,
  ...(c.parent_ids.length > 1 ? { merge_commit: true } : {}),
  ...(c.stats ? { additions: c.stats.additions, deletions: c.stats.deletions } : {}),
  web_url: c.web_url,
});

const compactMr = (m: MergeRequest) => ({
  project: m.project_path,
  iid: m.iid,
  title: m.title,
  state: m.state,
  author: m.author.username,
  created_at: m.created_at,
  merged_at: m.merged_at,
  merged_by: m.merged_by?.username ?? null,
  source_branch: m.source_branch,
  target_branch: m.target_branch,
  labels: m.labels,
  pipeline: m.pipeline.status,
  merge_commit_sha: m.merge_commit_sha,
  web_url: m.web_url,
});

const compactDiff = (d: FileDiff) => ({
  path: d.new_path,
  new_file: d.new_file,
  deleted_file: d.deleted_file,
  additions: d.additions,
  deletions: d.deletions,
  diff: d.diff,
});

function requireOne(projectArg: string | undefined, tlaArg: string | undefined) {
  if (!projectArg && !tlaArg)
    throw new Error('Pass either `project` (keybank/<TLA>00/<repo>) or `tla`.');
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function register(server: McpServer) {
  defineTool(server, 'search_projects', {
    title: 'Search GitLab projects',
    description: `Find repositories by name, description, app name or TLA. ${PROJECT_FORMAT} Use this to discover the repos of an application (e.g. tla="DEP") before reading code or history. Returns compact project records (path, kind, stack, last activity, open MR count), most recently active first.`,
    input: {
      query: z
        .string()
        .optional()
        .describe('Free text matched against path, description and app name, e.g. "customer".'),
      tla: tla.optional(),
      stack: z
        .enum(['java-spring', 'node-ts', 'python', 'react-web', 'terraform'])
        .optional()
        .describe('Filter by tech stack.'),
      kind: z
        .enum(['service', 'web', 'batch', 'infra'])
        .optional()
        .describe('Filter by repo kind.'),
      ...paginationShape,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const page = await api.listProjects({
        search: args.query,
        tla: args.tla,
        stack: args.stack,
        kind: args.kind,
        limit: args.limit,
        cursor: args.cursor,
      });
      return {
        total: page.total,
        next_cursor: page.next_cursor,
        items: page.items.map(compactProject),
      };
    },
  });

  defineTool(server, 'get_project', {
    title: 'Get GitLab project',
    description: `Project details: description, owning app (TLA) and its upstream/downstream TLAs, default branch, last commit, the 5 most recent commits on main and open merge requests. ${PROJECT_FORMAT}`,
    input: { project },
    annotations: READ_ONLY,
    run: async ({ project: id }) => {
      const [p, commits, mrs] = await Promise.all([
        api.getProject(id),
        api.listCommits(id, { limit: 5 }),
        api.listProjectMergeRequests(id, { state: 'opened', limit: 10 }),
      ]);
      return {
        ...p,
        last_commit: p.last_commit ? compactCommit(p.last_commit) : null,
        recent_commits: commits.items.map(compactCommit),
        open_merge_requests: mrs.items.map(compactMr),
      };
    },
  });

  defineTool(server, 'list_recent_commits', {
    title: 'List recent commits',
    description: `Recent commits on a branch (default main), newest first, for one project OR for every repo of an app (tla). Default window: last 24 hours. Use during RCA to see what changed recently in the failing app's upstream dependencies; merge commits carry merge_request_iid so you can open the MR. Includes additions/deletions per commit. ${PROJECT_FORMAT}`,
    input: {
      project: project.optional(),
      tla: tla.optional(),
      since: since.default('24h'),
      until: z.string().optional().describe('Upper time bound (relative or ISO).'),
      author: z.string().optional().describe('Filter by author username, e.g. "jsmith".'),
      ref: z.string().optional().describe('Branch or tag (default main).'),
      path: z
        .string()
        .optional()
        .describe(
          'Only commits touching this file or directory (project mode only), e.g. "src/main/resources".',
        ),
      ...paginationShape,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      requireOne(args.project, args.tla);
      const params = {
        since: args.since,
        until: args.until,
        author: args.author,
        ref_name: args.ref,
        with_stats: true,
        limit: args.limit,
        cursor: args.cursor,
      };
      const page = args.project
        ? await api.listCommits(args.project, { ...params, path: args.path })
        : await api.listGroupCommits(args.tla!, params);
      return {
        total: page.total,
        next_cursor: page.next_cursor,
        items: page.items.map(compactCommit),
      };
    },
  });

  defineTool(server, 'get_commit', {
    title: 'Get commit with diff',
    description:
      'One commit with its full message, stats, unified diff per file (against the first parent), and the merge request(s) it belongs to. For merge commits the diff is everything the MR brought into main.',
    input: {
      project,
      sha: z.string().min(4).describe('Commit sha, full or short (e.g. "5b368e89").'),
    },
    annotations: READ_ONLY,
    run: async ({ project: id, sha }) => {
      const [c, mrs] = await Promise.all([
        api.getCommit(id, sha),
        api.getCommitMergeRequests(id, sha),
      ]);
      return {
        ...compactCommit(c),
        message: c.message,
        parent_ids: c.parent_ids,
        stats: c.stats,
        merge_requests: mrs.map(compactMr),
        diffs: c.diffs.map(compactDiff),
      };
    },
  });

  defineTool(server, 'compare_refs', {
    title: 'Compare refs',
    description:
      'Commits and file diffs between two refs of a project (from → to). Use it to see everything that changed between a release tag and main, or between two shas (e.g. last known good vs current).',
    input: {
      project,
      from: z.string().min(1).describe('Base ref: tag, branch or sha, e.g. "v1.7.1".'),
      to: z.string().min(1).describe('Target ref, e.g. "main".'),
    },
    annotations: READ_ONLY,
    run: async ({ project: id, from, to }) => {
      const cmp = await api.compare(id, from, to);
      return {
        from,
        to,
        commits: cmp.commits.map(compactCommit),
        diffs: cmp.diffs.map(compactDiff),
        web_url: cmp.web_url,
      };
    },
  });

  defineTool(server, 'list_merge_requests', {
    title: 'List merge requests',
    description: `Merge requests for one project or every repo of an app (tla), newest activity first. Filter by state, merge time, labels and author. Typical RCA query: tla of an upstream app, state="merged", merged_after="6h". ${PROJECT_FORMAT}`,
    input: {
      project: project.optional(),
      tla: tla.optional(),
      state: z
        .enum(['opened', 'merged', 'closed', 'all'])
        .default('all')
        .describe('MR state (default all).'),
      merged_after: since.describe('Only MRs merged after this time (relative like "6h" or ISO).'),
      updated_after: since.describe('Only MRs updated after this time.'),
      labels: z.array(z.string()).optional().describe('MRs must have all of these labels.'),
      author: z.string().optional().describe('Author username.'),
      search: z.string().optional().describe('Text in title or description.'),
      ...paginationShape,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      requireOne(args.project, args.tla);
      const params = {
        state: args.state,
        merged_after: args.merged_after,
        updated_after: args.updated_after,
        labels: args.labels,
        author: args.author,
        search: args.search,
        limit: args.limit,
        cursor: args.cursor,
      };
      const page = args.project
        ? await api.listProjectMergeRequests(args.project, params)
        : await api.listGroupMergeRequests(args.tla!, params);
      return { total: page.total, next_cursor: page.next_cursor, items: page.items.map(compactMr) };
    },
  });

  defineTool(server, 'get_merge_request', {
    title: 'Get merge request with diffs',
    description:
      'Full merge request: description, author, approvals, merged by/at, pipeline, commits, review notes and the unified diff of every changed file. Use it to read exactly what a suspicious MR changed.',
    input: {
      project,
      iid: z
        .number()
        .int()
        .positive()
        .describe('MR number within the project (the !12 in the URL).'),
    },
    annotations: READ_ONLY,
    run: async ({ project: id, iid }) => {
      const [mr, commits, notes] = await Promise.all([
        api.getMergeRequestChanges(id, iid),
        api.getMergeRequestCommits(id, iid),
        api.listNotes(id, iid),
      ]);
      return {
        ...compactMr(mr),
        description: mr.description,
        approved_by: mr.approved_by.map((u) => u.username),
        merge_status: mr.merge_status,
        additions: mr.additions,
        deletions: mr.deletions,
        commits: commits.map(compactCommit),
        notes: notes.map((n) => ({
          author: n.author.username,
          created_at: n.created_at,
          body: n.body,
        })),
        changes: mr.changes.map(compactDiff),
      };
    },
  });

  defineTool(server, 'get_file_tree', {
    title: 'List repository files',
    description:
      'Directory listing of a project at a ref. Use recursive=true to get every file path in one call (repos are small: ~10-30 files).',
    input: {
      project,
      path: z
        .string()
        .optional()
        .describe('Directory to list, e.g. "src/main/java". Default: repo root.'),
      ref,
      recursive: z.boolean().default(true).describe('List all nested files (default true).'),
    },
    annotations: READ_ONLY,
    run: async ({ project: id, path, ref: r, recursive }) => {
      const entries = await api.getTree(id, { path, ref: r, recursive });
      return {
        ref: r ?? 'main',
        entries: entries
          .filter((e) => !recursive || e.type === 'blob')
          .map((e) => (recursive ? e.path : `${e.path}${e.type === 'tree' ? '/' : ''}`)),
      };
    },
  });

  defineTool(server, 'get_file', {
    title: 'Read a file',
    description:
      'Content of one file at a ref (default main), plus the sha of the last commit that changed it. Use exact paths from get_file_tree.',
    input: {
      project,
      path: z
        .string()
        .min(1)
        .describe('Repo-relative path, e.g. "src/main/resources/application.yml".'),
      ref,
    },
    annotations: READ_ONLY,
    run: async ({ project: id, path, ref: r }) => {
      const f = await api.getFile(id, path, r ?? 'main');
      return {
        path: f.file_path,
        ref: f.ref,
        size: f.size,
        last_commit_id: f.last_commit_id,
        web_url: f.web_url,
        content: f.content,
      };
    },
  });

  defineTool(server, 'fetch_repository', {
    title: 'Fetch whole repository (clone)',
    description:
      'Every file of a project at a ref in one call (the equivalent of a shallow clone), plus `archive_url`: a gzipped tarball you can download with `curl -sL <archive_url> | tar xz` to work on the code locally.',
    input: { project, ref },
    annotations: READ_ONLY,
    run: async ({ project: id, ref: r }) => api.getArchive(id, r ?? 'main'),
  });

  defineTool(server, 'create_merge_request', {
    title: 'Open a merge request with code changes',
    description: `Creates a branch from the target branch (default main), commits your file edits to it, and opens a merge request — all in one call. Edits are either full file content or exact find/replace pairs (a find must match exactly once; read the file first with get_file). Commits as svc_incident_auto unless author is given. Humans review and merge in the GitLab UI (there is no merge tool). Returns the MR with its diff and web_url to share in the incident. ${PROJECT_FORMAT}`,
    input: {
      project,
      title: z
        .string()
        .min(1)
        .describe('MR title, e.g. "fix(cif-client): restore 2000ms read timeout (INC0012345)".'),
      description: z
        .string()
        .describe(
          'Markdown: root cause, what the change does, how it was verified, incident number.',
        ),
      source_branch: z
        .string()
        .min(1)
        .describe(
          'New branch name, e.g. "fix/INC0012345-cif-timeout". Created from target_branch if missing.',
        ),
      target_branch: z.string().optional().describe('Branch to merge into (default main).'),
      changes: z.array(fileEdit).min(1).describe('File edits to commit on the source branch.'),
      labels,
      commit_message: z.string().optional().describe('Commit message (default: the title).'),
      author: z.string().optional().describe('Committer username (default svc_incident_auto).'),
    },
    annotations: WRITE,
    run: async (args) => {
      const mr = await api.createMergeRequest(args.project, {
        title: args.title,
        description: args.description,
        source_branch: args.source_branch,
        target_branch: args.target_branch,
        changes: args.changes,
        labels: args.labels,
        commit_message: args.commit_message,
        author: args.author,
      });
      return {
        ...compactMr(mr),
        merge_status: mr.merge_status,
        additions: mr.additions,
        deletions: mr.deletions,
        changes: mr.changes.map(compactDiff),
      };
    },
  });

  defineTool(server, 'update_merge_request', {
    title: 'Update a merge request',
    description:
      'Edit an MR: title, description (markdown), and labels (add_labels / remove_labels, or labels to replace all). Use to add root-cause details or an incident label after opening.',
    input: {
      project,
      iid: z.number().int().positive().describe('MR number within the project.'),
      title: z.string().optional().describe('New title.'),
      description: z.string().optional().describe('New description (replaces the old one).'),
      add_labels: labels.describe('Labels to add.'),
      remove_labels: labels.describe('Labels to remove.'),
      labels: labels.describe('Replace all labels with this list.'),
    },
    annotations: IDEMPOTENT_WRITE,
    run: async ({ project: id, iid, ...body }) =>
      compactMr(await api.updateMergeRequest(id, iid, body)),
  });

  defineTool(server, 'add_merge_request_note', {
    title: 'Comment on a merge request',
    description:
      'Adds a markdown comment to an MR, e.g. to explain the evidence (log lines, incident number) to reviewers, or to ask the author of a suspicious MR a question.',
    input: {
      project,
      iid: z.number().int().positive().describe('MR number within the project.'),
      body: z.string().min(1).describe('Markdown comment.'),
      author: z.string().optional().describe('Username (default svc_incident_auto).'),
    },
    annotations: WRITE,
    run: async ({ project: id, iid, body, author }) => {
      const note = await api.addNote(id, iid, { body, author });
      return {
        id: note.id,
        author: note.author.username,
        created_at: note.created_at,
        body: note.body,
      };
    },
  });

  defineTool(server, 'create_tag', {
    title: 'Create a tag',
    description:
      'Creates a git tag (e.g. a release "v1.7.3" or a marker like "last-known-good") pointing at a branch, tag or commit.',
    input: {
      project,
      tag_name: z.string().min(1).describe('Tag name, e.g. "v1.7.3".'),
      ref: z.string().min(1).describe('Branch, tag or sha to tag, e.g. "main".'),
      message: z.string().optional().describe('Annotation message.'),
    },
    annotations: WRITE,
    run: async ({ project: id, tag_name, ref: r, message }) => {
      const tag = await api.createTag(id, { tag_name, ref: r, message });
      return {
        name: tag.name,
        target: tag.target,
        commit_title: tag.commit.title,
        web_url: tag.web_url,
      };
    },
  });
}

const INSTRUCTIONS = `Simulated GitLab for KeyBank's application estate (gitlab.com/keybank).

Layout: one group per application, keybank/<TLA>00, holding that app's repos (e.g. keybank/PAY00/payments-api). The TLA is the same application code used in ServiceNow, alerts and logs, so an incident's app maps straight to a GitLab group. Every result carries a web_url you can paste into tickets and chat.

Suggested root-cause workflow when an app is failing:
1. Identify the failing app's upstream dependencies (get_project shows upstream_tlas; ServiceNow has the same graph).
2. For each upstream TLA (and the app itself), look for recent change: list_merge_requests(tla, state="merged", merged_after="6h") and list_recent_commits(tla, since="6h"). Merging to main only deploys to QV: production changes go out through ServiceNow change requests that KBR (svc_kbr) promotes, so confirm what actually reached production with ServiceNow list_change_requests (app_tla, implemented_after) or the kbr-<CHG> tags and KBR notes on MRs. A change promoted shortly before symptoms start is the prime suspect; beware unrelated changes landing at the same time.
3. Read the suspect: get_merge_request (diff, author, approvals) or get_commit. Confirm the mechanism with get_file / fetch_repository (e.g. a timeout, URL, feature flag or validation rule).
4. Fix it: create_merge_request with real code changes against main (find/replace edits on the exact lines, or full file content), a clear title, and a description with the root cause, the evidence, and the incident number. Add labels such as "incident". A human reviews and merges in the GitLab UI; merged, it is in QV only. To reach production it needs a ServiceNow change request (create_change_request, type emergency, planned_start "now") that KBR then promotes.
5. Optionally add_merge_request_note on the culprit MR linking your fix.`;

export const spec: McpServerSpec = {
  name: 'gitlab',
  title: 'GitLab (simulated)',
  version: '0.1.0',
  instructions: INSTRUCTIONS,
  register,
};
