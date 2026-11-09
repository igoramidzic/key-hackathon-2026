import { paginate, parseBody, parseQuery, parseTime } from '@sim/api-kit';
import type { MergeRequestWithChanges } from '@sim/contracts/gitlab';
import type { Hono } from 'hono';
import type { z } from 'zod';
import { getStore } from '../state';
import { commitJson, mrDetail, mrJson, noteJson } from '../store/serialize';
import { DEFAULT_AUTHOR, DEFAULT_MERGER, parseLabels } from '../store/store';
import type { MrObj, RepoState } from '../store/types';
import { approveBody, createMrBody, mergeBody, mrsQuery, noteBody, updateMrBody } from './schemas';

const P = '/api/v4/projects/:id';
const MR = `${P}/merge_requests/:iid`;

/** Filters and sorts MRs across the given projects. */
export function filterMrs(states: RepoState[], q: z.infer<typeof mrsQuery>) {
  const labels = parseLabels(q.labels) ?? [];
  const mergedAfter = parseTime(q.merged_after)?.getTime();
  const mergedBefore = parseTime(q.merged_before)?.getTime();
  const updatedAfter = parseTime(q.updated_after)?.getTime();
  const createdAfter = parseTime(q.created_after)?.getTime();
  const term = q.search?.toLowerCase();
  const author = q.author?.toLowerCase();
  const out: { s: RepoState; mr: MrObj }[] = [];
  for (const s of states) {
    if (q.tla && s.repo.tla !== q.tla.toUpperCase()) continue;
    for (const mr of s.mrs) {
      if (q.state !== 'all' && mr.state !== q.state) continue;
      if (labels.some((l) => !mr.labels.includes(l))) continue;
      if (author && mr.author.toLowerCase() !== author) continue;
      if (mergedAfter !== undefined && (mr.mergedAt === null || mr.mergedAt < mergedAfter))
        continue;
      if (mergedBefore !== undefined && (mr.mergedAt === null || mr.mergedAt > mergedBefore))
        continue;
      if (updatedAfter !== undefined && mr.updatedAt < updatedAfter) continue;
      if (createdAfter !== undefined && mr.createdAt < createdAfter) continue;
      if (
        term &&
        !mr.title.toLowerCase().includes(term) &&
        !mr.description.toLowerCase().includes(term)
      )
        continue;
      out.push({ s, mr });
    }
  }
  const orderBy =
    q.order_by ?? (mergedAfter !== undefined || q.state === 'merged' ? 'merged_at' : 'updated_at');
  const key = (mr: MrObj) =>
    orderBy === 'created_at'
      ? mr.createdAt
      : orderBy === 'merged_at'
        ? (mr.mergedAt ?? mr.updatedAt)
        : mr.updatedAt;
  const dir = q.sort === 'asc' ? 1 : -1;
  out.sort((a, b) => (key(a.mr) - key(b.mr)) * dir);
  return out;
}

export function registerMrRoutes(app: Hono) {
  const list = (states: RepoState[], q: z.infer<typeof mrsQuery>) => {
    const store = getStore();
    const page = paginate(filterMrs(states, q), q);
    return { ...page, items: page.items.map(({ s, mr }) => mrJson(store, s, mr)) };
  };

  app.get('/api/v4/merge_requests', (c) =>
    c.json(list(getStore().allProjects(), parseQuery(c, mrsQuery))),
  );

  app.get('/api/v4/groups/:id/merge_requests', (c) => {
    const store = getStore();
    const g = store.group(c.req.param('id'));
    return c.json(
      list(
        g.projectIds.map((id) => store.repos.get(id)!),
        parseQuery(c, mrsQuery),
      ),
    );
  });

  app.get(`${P}/merge_requests`, (c) => {
    const s = getStore().project(c.req.param('id'));
    return c.json(list([s], parseQuery(c, mrsQuery)));
  });

  app.post(`${P}/merge_requests`, async (c) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const body = await parseBody(c, createMrBody);
    const mr = store.createMr(s, body);
    const result: MergeRequestWithChanges = {
      ...mrDetail(store, s, mr),
      changes: store.mrDiffs(s, mr),
    };
    return c.json(result, 201);
  });

  const load = (c: { req: { param: (k: string) => string } }) => {
    const store = getStore();
    const s = store.project(c.req.param('id'));
    const mr = store.mr(s, Number(c.req.param('iid')));
    return { store, s, mr };
  };

  app.get(MR, (c) => {
    const { store, s, mr } = load(c);
    return c.json(mrDetail(store, s, mr));
  });

  app.get(`${MR}/changes`, (c) => {
    const { store, s, mr } = load(c);
    const result: MergeRequestWithChanges = {
      ...mrDetail(store, s, mr),
      changes: store.mrDiffs(s, mr),
    };
    return c.json(result);
  });

  app.get(`${MR}/commits`, (c) => {
    const { store, s, mr } = load(c);
    return c.json([...mr.commits].reverse().map((sha) => commitJson(s, store.commit(s, sha))));
  });

  app.put(MR, async (c) => {
    const { store, s, mr } = load(c);
    const body = await parseBody(c, updateMrBody);
    store.updateMr(s, mr, body);
    return c.json(mrDetail(store, s, mr));
  });

  app.put(`${MR}/merge`, async (c) => {
    const { store, s, mr } = load(c);
    const body = await parseBody(c, mergeBody);
    store.mergeMr(s, mr, body.merged_by?.trim() || DEFAULT_MERGER, {
      message: body.merge_commit_message,
    });
    return c.json(mrDetail(store, s, mr));
  });

  app.post(`${MR}/approve`, async (c) => {
    const { store, s, mr } = load(c);
    const body = await parseBody(c, approveBody);
    store.approveMr(mr, body.username?.trim() || DEFAULT_MERGER);
    return c.json(mrDetail(store, s, mr));
  });

  app.get(`${MR}/notes`, (c) => {
    const { s, mr } = load(c);
    return c.json(mr.notes.map((n) => noteJson(s, mr, n)));
  });

  app.post(`${MR}/notes`, async (c) => {
    const { store, s, mr } = load(c);
    const body = await parseBody(c, noteBody);
    const note = store.addNote(s, mr, body.body, body.author?.trim() || DEFAULT_AUTHOR);
    return c.json(noteJson(s, mr, note), 201);
  });
}
