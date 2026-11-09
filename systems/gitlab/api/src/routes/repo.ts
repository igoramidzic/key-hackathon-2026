import { badRequest, notFound, paginate, parseBody, parseQuery, parseTime } from '@sim/api-kit';
import type {
  Commit,
  CommitWithDiff,
  Compare,
  RepoArchive,
  RepoFile,
  TreeEntry,
} from '@sim/contracts/gitlab';
import { shaFor } from '@sim/world';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { getStore } from '../state';
import { diffStats, diffTrees } from '../store/diff';
import {
  archiveUrl,
  branchJson,
  commitJson,
  commitWithStats,
  groupDetail,
  groupJson,
  mrJson,
  projectDetail,
  projectJson,
  tagJson,
} from '../store/serialize';
import { DEFAULT_AUTHOR } from '../store/store';
import { createTarGz } from '../store/tar';
import type { CommitObj, RepoState } from '../store/types';
import { normalizePath } from '../templates/index';
import { webUrls } from '../urls';
import {
  branchBody,
  commitsQuery,
  createCommitBody,
  pageSchema,
  projectsQuery,
  tagBody,
} from './schemas';

const P = '/api/v4/projects/:id';

function matchesAuthor(c: CommitObj, author: string | undefined) {
  if (!author) return true;
  const a = author.toLowerCase();
  return c.author.toLowerCase() === a || c.author.toLowerCase().includes(a);
}

export function filterProjects(states: RepoState[], q: z.infer<typeof projectsQuery>) {
  const term = q.search?.trim().toLowerCase();
  let items = states.filter((s) => {
    if (q.tla && s.repo.tla !== q.tla.toUpperCase()) return false;
    if (q.stack && s.repo.stack !== q.stack) return false;
    if (q.kind && s.repo.kind !== q.kind) return false;
    if (!term) return true;
    return (
      s.repo.path.toLowerCase().includes(term) ||
      s.repo.description.toLowerCase().includes(term) ||
      s.app.name.toLowerCase().includes(term) ||
      s.repo.tla.toLowerCase() === term
    );
  });
  const dir = (q.sort ?? (q.order_by === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const key = (s: RepoState): number | string => {
    switch (q.order_by) {
      case 'name':
        return s.repo.path;
      case 'id':
        return s.repo.id;
      case 'created_at':
        return s.createdAt;
      default:
        return s.lastActivityAt;
    }
  };
  items = [...items].sort((a, b) => {
    // Exact name/TLA matches first when searching.
    if (term) {
      const ea = a.repo.name === term || a.repo.tla.toLowerCase() === term ? 0 : 1;
      const eb = b.repo.name === term || b.repo.tla.toLowerCase() === term ? 0 : 1;
      if (ea !== eb) return ea - eb;
    }
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -dir : ka > kb ? dir : 0;
  });
  return items;
}

/** Commits on `ref` with the standard filters. */
export function listCommits(
  s: RepoState,
  q: {
    ref_name?: string;
    since?: string;
    until?: string;
    author?: string;
    path?: string;
    first_parent?: boolean;
  },
): CommitObj[] {
  const store = getStore();
  const head = store.resolveRef(s, q.ref_name);
  const since = parseTime(q.since)?.getTime();
  const until = parseTime(q.until)?.getTime();
  return store
    .history(s, head, q.first_parent)
    .filter(
      (c) =>
        (since === undefined || c.committedAt >= since) &&
        (until === undefined || c.committedAt <= until) &&
        matchesAuthor(c, q.author) &&
        (!q.path || store.touches(s, c, q.path)),
    );
}

export function registerRepoRoutes(app: Hono) {
  // ----- groups -----
  app.get('/api/v4/groups', (c) => {
    const q = parseQuery(c, z.object({ ...pageSchema.shape, search: z.string().optional() }));
    const term = q.search?.trim().toLowerCase();
    const groups = getStore()
      .groups.filter(
        (g) =>
          !term ||
          g.fullPath.toLowerCase().includes(term) ||
          g.description.toLowerCase().includes(term) ||
          g.tla?.toLowerCase() === term,
      )
      .sort((a, b) => {
        if (term) {
          const ea = a.tla?.toLowerCase() === term ? 0 : 1;
          const eb = b.tla?.toLowerCase() === term ? 0 : 1;
          if (ea !== eb) return ea - eb;
        }
        return a.parentId === null
          ? -1
          : b.parentId === null
            ? 1
            : a.fullPath.localeCompare(b.fullPath);
      });
    return c.json(paginate(groups.map(groupJson), q));
  });

  app.get('/api/v4/groups/:id', (c) => {
    const store = getStore();
    return c.json(groupDetail(store, store.group(c.req.param('id'))));
  });

  app.get('/api/v4/groups/:id/projects', (c) => {
    const store = getStore();
    const g = store.group(c.req.param('id'));
    const q = parseQuery(c, projectsQuery);
    const states = g.projectIds.map((id) => store.repos.get(id)!);
    return c.json(
      paginate(
        filterProjects(states, q).map((s) => projectJson(store, s)),
        q,
      ),
    );
  });

  app.get('/api/v4/groups/:id/commits', (c) => {
    const store = getStore();
    const g = store.group(c.req.param('id'));
    const q = parseQuery(c, commitsQuery);
    const since = q.since ?? '7d';
    const items: { s: RepoState; c: CommitObj }[] = [];
    for (const id of g.projectIds) {
      const s = store.repos.get(id)!;
      let ref = q.ref_name;
      if (ref && !s.branches.has(ref) && !s.tags.has(ref)) continue;
      ref ??= s.repo.defaultBranch;
      for (const commit of listCommits(s, { ...q, since, ref_name: ref, path: undefined })) {
        items.push({ s, c: commit });
      }
    }
    items.sort((a, b) => b.c.committedAt - a.c.committedAt);
    const page = paginate(items, q);
    return c.json({
      ...page,
      items: page.items.map(({ s, c: commit }) =>
        q.with_stats ? commitWithStats(store, s, commit) : commitJson(s, commit),
      ),
    });
  });

  // ----- projects -----
  app.get('/api/v4/projects', (c) => {
    const store = getStore();
    const q = parseQuery(c, projectsQuery);
    return c.json(
      paginate(
        filterProjects(store.allProjects(), q).map((s) => projectJson(store, s)),
        q,
      ),
    );
  });

  app.get(P, (c) => {
    const store = getStore();
    return c.json(projectDetail(store, store.project(c.req.param('id'))));
  });

  // ----- tree & files -----
  app.get(`${P}/repository/tree`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const q = parseQuery(
      c,
      z.object({
        path: z.string().optional(),
        ref: z.string().optional(),
        recursive: z
          .string()
          .optional()
          .transform((v) => v === 'true' || v === '1'),
      }),
    );
    const sha = store.resolveRef(s, q.ref);
    const tree = store.tree(s, sha);
    const dir = q.path ? normalizePath(q.path).replace(/\/$/, '') : '';
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map<string, TreeEntry>();
    let found = !dir;
    for (const [path, content] of tree) {
      if (!path.startsWith(prefix)) continue;
      found = true;
      const rest = path.slice(prefix.length);
      const parts = rest.split('/');
      if (q.recursive) {
        for (let i = 1; i < parts.length; i++) {
          const sub = prefix + parts.slice(0, i).join('/');
          if (!entries.has(sub)) {
            entries.set(sub, {
              id: shaFor(`tree:${sha}:${sub}`),
              name: parts[i - 1]!,
              type: 'tree',
              path: sub,
              mode: '040000',
            });
          }
        }
        entries.set(path, {
          id: shaFor(content),
          name: parts[parts.length - 1]!,
          type: 'blob',
          path,
          mode: '100644',
        });
      } else if (parts.length === 1) {
        entries.set(path, {
          id: shaFor(content),
          name: parts[0]!,
          type: 'blob',
          path,
          mode: '100644',
        });
      } else {
        const sub = prefix + parts[0]!;
        if (!entries.has(sub)) {
          entries.set(sub, {
            id: shaFor(`tree:${sha}:${sub}`),
            name: parts[0]!,
            type: 'tree',
            path: sub,
            mode: '040000',
          });
        }
      }
    }
    if (!found) throw notFound(`Tree not found: ${dir} at ${q.ref ?? s.repo.defaultBranch}`);
    const list = [...entries.values()].sort((a, b) =>
      a.type !== b.type ? (a.type === 'tree' ? -1 : 1) : a.path.localeCompare(b.path),
    );
    return c.json(list);
  });

  const readFile = (c: {
    req: { param: (k: string) => string; query: (k: string) => string | undefined };
  }) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const path = normalizePath(c.req.param('file_path'));
    const ref = c.req.query('ref') || s.repo.defaultBranch;
    const sha = store.resolveRef(s, ref);
    const content = store.tree(s, sha).get(path);
    return { store, s, path, ref, sha, content };
  };

  app.get(`${P}/repository/files/:file_path/raw`, (c) => {
    const { s, path, ref, content } = readFile(c);
    if (content === undefined)
      throw notFound(`File not found: ${path} at ${ref} in ${s.repo.path}`);
    return c.text(content, 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  app.get(`${P}/repository/files/:file_path`, (c) => {
    const { store, s, path, ref, sha, content } = readFile(c);
    if (content === undefined)
      throw notFound(`File not found: ${path} at ${ref} in ${s.repo.path}`);
    const last = store.lastCommitFor(s, sha, path);
    const body: RepoFile = {
      file_name: path.split('/').pop()!,
      file_path: path,
      size: Buffer.byteLength(content),
      encoding: 'text',
      content,
      content_sha256: shaFor(content),
      ref,
      blob_id: shaFor(content),
      commit_id: sha,
      last_commit_id: last?.sha ?? sha,
      web_url: webUrls.blob(s.repo.path, ref, path),
    };
    return c.json(body);
  });

  const archive = (c: Context, forced?: 'json' | 'tar.gz') => {
    const store = getStore();
    const s = store.project(c.req.param('id') ?? '');
    const ref = c.req.query('ref') || s.repo.defaultBranch;
    const format = forced ?? (c.req.query('format') || 'tar.gz').replace(/^\./, '');
    const sha = store.resolveRef(s, ref);
    const tree = store.tree(s, sha);
    const files = [...tree.entries()].map(([path, content]) => ({ path, content }));
    if (format === 'json') {
      const body: RepoArchive = {
        project: s.repo.path,
        ref,
        sha,
        file_count: files.length,
        files,
        archive_url: archiveUrl(s, ref),
      };
      return c.json(body);
    }
    if (format !== 'tar.gz' && format !== 'tgz')
      throw badRequest(`Unsupported archive format: ${format}`);
    const root = `${s.repo.name}-${ref.replace(/[^A-Za-z0-9._-]+/g, '-')}-${sha.slice(0, 8)}`;
    const commit = store.commit(s, sha);
    const tar = createTarGz(root, files, commit.committedAt);
    return c.body(new Uint8Array(tar), 200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${root}.tar.gz"`,
    });
  };
  app.get(`${P}/repository/archive`, (c) => archive(c));
  app.get(`${P}/repository/archive.tar.gz`, (c) => archive(c, 'tar.gz'));
  app.get(`${P}/repository/archive.json`, (c) => archive(c, 'json'));

  // ----- commits -----
  app.get(`${P}/repository/commits`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const q = parseQuery(c, commitsQuery);
    const page = paginate(listCommits(s, q), q);
    return c.json({
      ...page,
      items: page.items.map((commit) =>
        q.with_stats ? commitWithStats(store, s, commit) : commitJson(s, commit),
      ),
    });
  });

  app.post(`${P}/repository/commits`, async (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const body = await parseBody(c, createCommitBody);
    const branch = s.branches.get(body.branch);
    // GitLab requires start_branch for a new branch; we default to main to be forgiving.
    const baseSha = branch
      ? branch.head
      : store.resolveRef(s, body.start_branch ?? s.repo.defaultBranch);
    const tree = store.tree(s, baseSha);
    const changes = new Map<string, string | null>();
    for (const a of body.actions) {
      const path = normalizePath(a.file_path);
      const exists = changes.has(path) ? changes.get(path) !== null : tree.has(path);
      if (a.action === 'create' && exists)
        throw badRequest(`A file with this name already exists: ${path}`);
      if (a.action === 'update' && !exists)
        throw badRequest(`A file with this name doesn't exist: ${path}`);
      changes.set(path, a.content);
    }
    const commit = store.commitChanges(s, {
      branch: body.branch,
      startRef: body.start_branch,
      message: body.commit_message,
      author: body.author?.trim() || DEFAULT_AUTHOR,
      changes,
    });
    return c.json(commitWithStats(store, s, commit), 201);
  });

  app.get(`${P}/repository/commits/:sha`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const commit = store.commit(s, store.resolveRef(s, c.req.param('sha')));
    const diffs = store.commitDiffs(s, commit);
    const body: CommitWithDiff = {
      ...commitJson(s, commit, diffStats(diffs)),
      stats: diffStats(diffs),
      diffs,
    };
    return c.json(body);
  });

  app.get(`${P}/repository/commits/:sha/diff`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const commit = store.commit(s, store.resolveRef(s, c.req.param('sha')));
    return c.json(store.commitDiffs(s, commit));
  });

  app.get(`${P}/repository/commits/:sha/merge_requests`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const commit = store.commit(s, store.resolveRef(s, c.req.param('sha')));
    const mrs = s.mrs.filter(
      (m) =>
        m.iid === commit.mrIid || m.mergeCommitSha === commit.sha || m.commits.includes(commit.sha),
    );
    return c.json(mrs.map((m) => mrJson(store, s, m)));
  });

  app.get(`${P}/repository/compare`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const q = parseQuery(c, z.object({ from: z.string().min(1), to: z.string().min(1) }));
    const from = store.resolveRef(s, q.from);
    const to = store.resolveRef(s, q.to);
    const fromAncestors = store.ancestors(s, from);
    const commits: Commit[] = store
      .history(s, to)
      .filter((x) => !fromAncestors.has(x.sha))
      .map((x) => commitJson(s, x));
    const body: Compare = {
      from: q.from,
      to: q.to,
      commit: commits[0] ?? null,
      commits,
      diffs: diffTrees(store.tree(s, from), store.tree(s, to)),
      compare_same_ref: from === to,
      web_url: webUrls.compare(s.repo.path, q.from, q.to),
    };
    return c.json(body);
  });

  // ----- branches & tags -----
  app.get(`${P}/repository/branches`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const q = parseQuery(c, z.object({ ...pageSchema.shape, search: z.string().optional() }));
    const term = q.search?.toLowerCase();
    const branches = [...s.branches.values()]
      .filter((b) => !term || b.name.toLowerCase().includes(term))
      .sort((a, b) =>
        a.name === s.repo.defaultBranch
          ? -1
          : b.name === s.repo.defaultBranch
            ? 1
            : store.commit(s, b.head).committedAt - store.commit(s, a.head).committedAt,
      );
    return c.json(
      paginate(
        branches.map((b) => branchJson(store, s, b)),
        q,
      ),
    );
  });

  app.get(`${P}/repository/branches/:branch`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const b = s.branches.get(c.req.param('branch'));
    if (!b) throw notFound(`Branch not found: ${c.req.param('branch')}`);
    return c.json(branchJson(store, s, b));
  });

  app.post(`${P}/repository/branches`, async (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const body = await parseBody(c, branchBody);
    return c.json(branchJson(store, s, store.createBranch(s, body.branch, body.ref)), 201);
  });

  app.get(`${P}/repository/tags`, (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const q = parseQuery(c, pageSchema);
    const tags = [...s.tags.values()].sort((a, b) => b.createdAt - a.createdAt);
    return c.json(
      paginate(
        tags.map((t) => tagJson(store, s, t)),
        q,
      ),
    );
  });

  app.post(`${P}/repository/tags`, async (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const body = await parseBody(c, tagBody);
    const tag = store.createTag(
      s,
      body.tag_name,
      body.ref,
      body.message ?? '',
      body.author?.trim() || DEFAULT_AUTHOR,
    );
    return c.json(tagJson(store, s, tag), 201);
  });
}
