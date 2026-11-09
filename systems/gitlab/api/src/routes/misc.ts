import { notFound, paginate, parseBody, parseQuery, parseTime } from '@sim/api-kit';
import type { ResetResult } from '@sim/contracts';
import type { AdminMergeResult } from '@sim/contracts/gitlab';
import { getWorld } from '@sim/world';
import type { Hono } from 'hono';
import { z } from 'zod';
import { getStore, resetStore } from '../state';
import { commitRef, eventJson, isGitlabUser, userJson } from '../store/serialize';
import { webUrls } from '../urls';
import { adminCommitBody, adminMergeBody, pageSchema } from './schemas';

const SERVICE = 'gitlab-api';

export function registerMiscRoutes(app: Hono) {
  // ----- users -----
  app.get('/api/v4/users', (c) => {
    const store = getStore();
    const q = parseQuery(
      c,
      z.object({ ...pageSchema.shape, search: z.string().optional(), tla: z.string().optional() }),
    );
    const term = q.search?.toLowerCase();
    const tla = q.tla?.toUpperCase();
    const users = getWorld()
      .people.filter(isGitlabUser)
      .filter((p) => !tla || (store.userTlas.get(p.username) ?? []).includes(tla))
      .filter(
        (p) =>
          !term ||
          p.username.toLowerCase().includes(term) ||
          p.name.toLowerCase().includes(term) ||
          p.email.toLowerCase().includes(term),
      );
    return c.json(
      paginate(
        users.map((p) => userJson(store, p)),
        q,
      ),
    );
  });

  app.get('/api/v4/users/:username', (c) => {
    const p = getWorld().peopleByUsername.get(c.req.param('username'));
    if (!p) throw notFound(`User not found: ${c.req.param('username')}`);
    return c.json(userJson(getStore(), p));
  });

  // ----- activity -----
  app.get('/api/v4/events', (c) => {
    const store = getStore();
    const q = parseQuery(
      c,
      z.object({
        ...pageSchema.shape,
        since: z.string().optional(),
        tla: z.string().optional(),
        project: z.string().optional(),
        author: z.string().optional(),
        action: z.string().optional(),
      }),
    );
    const since = parseTime(q.since)?.getTime();
    const tla = q.tla?.toUpperCase();
    const projectId = q.project ? store.project(q.project).repo.id : undefined;
    const action = q.action?.toLowerCase();
    const out = [];
    for (let i = store.events.length - 1; i >= 0; i--) {
      const e = store.events[i]!;
      if (since !== undefined && e.at < since) break;
      if (e.at > Date.now() + 1000) continue;
      if (projectId !== undefined && e.repoId !== projectId) continue;
      if (tla && store.repos.get(e.repoId)!.repo.tla !== tla) continue;
      if (q.author && e.author !== q.author) continue;
      if (action && !e.action.startsWith(action === 'pushed' ? 'pushed' : action)) continue;
      out.push(e);
    }
    const page = paginate(out, q);
    return c.json({ ...page, items: page.items.map((e) => eventJson(store, e)) });
  });

  // ----- simulator admin -----
  app.post('/admin/merge', async (c) => {
    const body = await parseBody(c, adminMergeBody);
    const { state, mr, merge } = getStore().adminMerge(body);
    const result: AdminMergeResult = {
      project: state.repo.path,
      iid: mr.iid,
      web_url: webUrls.mr(state.repo.path, mr.iid),
      merge_commit: commitRef(state, merge),
    };
    return c.json(result);
  });

  app.post('/admin/commit', async (c) => {
    const body = await parseBody(c, adminCommitBody);
    const { state, commit } = getStore().adminCommit(body);
    return c.json(commitRef(state, commit));
  });

  app.post('/admin/reset', (c) => {
    resetStore();
    return c.json<ResetResult>({ ok: true, service: SERVICE, reset_at: new Date().toISOString() });
  });
}
