import {
  badRequest,
  createApi,
  csv,
  notFound,
  pageQuery,
  paginate,
  parseBody,
  parseQuery,
} from '@sim/api-kit';
import type { ResetResult } from '@sim/contracts';
import {
  ACTIVITY_KINDS,
  ACTIVITY_TABLES,
  type ActivityKind,
  type ActivityTable,
  type ActivityTailResult,
  CHANGE_RISKS,
  CHANGE_STATES,
  CHANGE_TYPES,
  type ChangeRisk,
  type ChangeState,
  type ChangeType,
  CLOSE_CODES,
  type CloseCode,
  CONTACT_TYPES,
  type ContactType,
  INCIDENT_RELATIONSHIPS,
  INCIDENT_STATES,
  type IncidentState,
  isActiveState,
  LINK_TYPE_LABELS,
  LINK_TYPES,
  type Priority,
} from '@sim/contracts/servicenow';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ActivityFeed, type ActivityFilter } from './activity';
import { ChangeStore } from './changes';
import { Directory, matchesQuery } from './directory';
import { IncidentStore } from './incidents';

export const SERVICE = 'servicenow-api';

// ---------------------------------------------------------------------------
// Input schemas (lenient where it helps agents: "In Progress", "P2", "solution provided")
// ---------------------------------------------------------------------------

const stateValue = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
          .replace(/^cancelled$/, 'canceled')
      : v,
  z.enum(INCIDENT_STATES as [IncidentState, ...IncidentState[]]),
);

const level = z.coerce
  .number()
  .int()
  .min(1, 'must be 1 (High), 2 (Medium) or 3 (Low)')
  .max(3, 'must be 1 (High), 2 (Medium) or 3 (Low)')
  .transform((n) => n as 1 | 2 | 3);

const closeCode = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? (CLOSE_CODES.find((c) => c.toLowerCase() === v.trim().toLowerCase().replace(/_/g, ' ')) ??
        v)
      : v,
  z.enum(CLOSE_CODES as [CloseCode, ...CloseCode[]], {
    error: () => `close_code must be one of: ${CLOSE_CODES.join(', ')}`,
  }),
);

const contactType = z
  .enum(CONTACT_TYPES as [string, ...string[]])
  .transform((v) => v as (typeof CONTACT_TYPES)[number]);

const text = z.string().trim().min(1);

const linkInput = z.object({
  type: z
    .enum(LINK_TYPES as [string, ...string[]])
    .transform((v) => v as (typeof LINK_TYPES)[number]),
  url: z.url(),
  title: z.string().trim().optional(),
});

const createSchema = z.object({
  short_description: text.max(160),
  description: z.string().optional(),
  app_tla: text.optional(),
  caller: text.optional(),
  opened_by: text.optional(),
  contact_type: contactType.optional(),
  category: text.optional(),
  subcategory: text.optional(),
  impact: level.optional(),
  urgency: level.optional(),
  assignment_group: text.optional(),
  assigned_to: text.optional(),
  parent_incident: text.optional(),
  child_incidents: z.array(text).max(100).optional(),
});

const updateSchema = z.object({
  state: stateValue.optional(),
  impact: level.optional(),
  urgency: level.optional(),
  assignment_group: text.nullable().optional(),
  assigned_to: text.nullable().optional(),
  short_description: text.max(160).optional(),
  description: z.string().optional(),
  category: text.optional(),
  subcategory: z.string().nullable().optional(),
  app_tla: text.nullable().optional(),
  caller: text.nullable().optional(),
  contact_type: contactType.optional(),
  parent_incident: text.nullable().optional(),
  close_code: closeCode.optional(),
  close_notes: text.optional(),
  work_note: z.string().optional(),
  comment: z.string().optional(),
  add_links: z.array(linkInput).max(20).optional(),
  updated_by: text.optional(),
});

const linkChildrenSchema = z.object({
  children: z.array(text).min(1).max(100),
  work_note: z.string().optional(),
  child_comment: z.string().optional(),
  updated_by: text.optional(),
});

const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]]);
const journalSchema = z.object({
  type: z.enum(['work_note', 'comment']),
  text,
  author: text.optional(),
});

const sorts = [
  'opened_at',
  '-opened_at',
  'updated_at',
  '-updated_at',
  'priority',
  '-priority',
  'number',
  '-number',
] as const;

const incidentListSchema = z.object({
  ...pageQuery,
  state: csv,
  priority: csv,
  active: z.enum(['true', 'false']).optional(),
  app_tla: z.string().optional(),
  assignment_group: z.string().optional(),
  assigned_to: z.string().optional(),
  caller: z.string().optional(),
  contact_type: csv,
  category: z.string().optional(),
  parent_incident: z.string().optional(),
  relationship: enumOf(INCIDENT_RELATIONSHIPS).optional(),
  q: z.string().optional(),
  opened_after: z.string().optional(),
  opened_before: z.string().optional(),
  sort: z.enum(sorts).optional(),
});

/** Comma-separated enum values from a csv query param, with a helpful error. */
function csvEnum<T extends string>(
  values: string[] | undefined,
  allowed: readonly T[],
  field: string,
) {
  return values?.map((v) => {
    const key = v
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!(allowed as readonly string[]).includes(key)) {
      throw badRequest(`Invalid ${field} '${v}' (use ${allowed.join(', ')}; comma separated)`);
    }
    return key as T;
  });
}

// ---------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------

const lowerKey = (v: unknown) =>
  typeof v === 'string'
    ? v
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : v;
const changeType = z.preprocess(lowerKey, enumOfValues<ChangeType>(CHANGE_TYPES, 'type'));
const changeRisk = z.preprocess(lowerKey, enumOfValues<ChangeRisk>(CHANGE_RISKS, 'risk'));

function enumOfValues<T extends string>(values: readonly T[], field: string) {
  return z.enum(values as unknown as [T, ...T[]], {
    error: () => `${field} must be one of: ${values.join(', ')}`,
  });
}

const mrInput = z.union([
  z.string().trim().min(1),
  z.object({ project: z.string().trim().min(1), iid: z.coerce.number().int().positive() }),
]);

const changeCreateSchema = z.object({
  short_description: text.max(160),
  app_tla: text,
  merge_requests: z.array(mrInput).min(1, 'merge_requests needs at least one MR').max(50),
  planned_start: text.optional(),
  type: changeType.optional(),
  risk: changeRisk.optional(),
  description: z.string().optional(),
  justification: z.string().optional(),
  backout_plan: z.string().optional(),
  requested_by: text.optional(),
  assignment_group: text.optional(),
  related_incidents: z.array(text).max(20).optional(),
});

const changeUpdateSchema = z.object({
  state: z
    .preprocess(
      lowerKey,
      z.enum(['new', 'scheduled', 'canceled'], {
        error: () =>
          'state can be set to new, scheduled or canceled (KBR moves it to implement and closed)',
      }),
    )
    .optional(),
  planned_start: text.optional(),
  short_description: text.max(160).optional(),
  description: z.string().optional(),
  type: changeType.optional(),
  risk: changeRisk.optional(),
  add_merge_requests: z.array(mrInput).max(50).optional(),
  related_incidents: z.array(text).max(20).optional(),
  work_note: z.string().optional(),
  updated_by: text.optional(),
});

const changeSorts = [
  'planned_start',
  '-planned_start',
  'opened_at',
  '-opened_at',
  'implemented_at',
  '-implemented_at',
  'number',
  '-number',
] as const;

const changeListSchema = z.object({
  ...pageQuery,
  state: csv,
  type: csv,
  active: z.enum(['true', 'false']).optional(),
  app_tla: z.string().optional(),
  project: z.string().optional(),
  merge_request: z.string().optional(),
  requested_by: z.string().optional(),
  related_incident: z.string().optional(),
  q: z.string().optional(),
  implemented_after: z.string().optional(),
  implemented_before: z.string().optional(),
  planned_after: z.string().optional(),
  planned_before: z.string().optional(),
  sort: z.enum(changeSorts).optional(),
});

const changeMrRecord = z.object({
  project: text,
  iid: z.number().int().positive(),
  reference: text,
  web_url: z.string(),
  title: z.string().nullable(),
  state: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
});

const deploymentRecord = z.object({
  project: text,
  app_tla: text,
  service: z.string().nullable(),
  sha: text,
  short_sha: text,
  version: z.string().nullable(),
  tag: z.string().nullable(),
  deployed_at: z.string(),
});

const releaseSchema = z.object({
  status: z.enum(['running', 'succeeded', 'failed']),
  release_id: text.optional(),
  merge_requests: z.array(changeMrRecord).optional(),
  deployments: z.array(deploymentRecord).optional(),
  note: z.string().optional(),
});

const importSchema = z.object({
  short_description: text.max(160),
  app_tla: text,
  merge_requests: z.array(changeMrRecord).min(1),
  type: changeType.optional(),
  risk: changeRisk.optional(),
  state: z.enum(['scheduled', 'closed']),
  description: z.string().optional(),
  requested_by: text,
  opened_at: text,
  planned_start: text,
  release_id: text.optional(),
  deployments: z.array(deploymentRecord).optional(),
});

const activityFilterShape = {
  table: csv,
  kind: csv,
  app_tla: csv,
  contact_type: csv,
};
const activitySeq = z.coerce.number().int().min(0);
const activityTailSchema = z.object({
  ...activityFilterShape,
  after_seq: activitySeq.optional(),
  wait_seconds: z.coerce.number().min(0).max(30).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const activityStreamSchema = z.object({
  ...activityFilterShape,
  after_seq: activitySeq.optional(),
});

function activityFilter(
  q: z.infer<typeof activityTailSchema> | z.infer<typeof activityStreamSchema>,
): ActivityFilter {
  return {
    tables: csvEnum<ActivityTable>(q.table, ACTIVITY_TABLES, 'table'),
    kinds: csvEnum<ActivityKind>(q.kind, ACTIVITY_KINDS, 'kind'),
    appTlas: q.app_tla?.map((t) => t.toUpperCase()),
    contactTypes: csvEnum<ContactType>(q.contact_type, CONTACT_TYPES, 'contact_type'),
  };
}

const HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function buildApp() {
  const dir = new Directory();
  const store = new IncidentStore(dir);
  const changes = new ChangeStore(dir, store);
  const activity = new ActivityFeed(store, changes);

  const app = createApi({
    service: SERVICE,
    stats: () => ({
      incidents: store.records.length,
      open_incidents: store.records.filter((r) => isActiveState(r.state)).length,
      apps: dir.world.apps.length,
      users: dir.world.people.length,
      groups: dir.world.groups.length,
      change_requests: changes.records.length,
      scheduled_changes: changes.records.filter((r) => r.state === 'scheduled').length,
      activity_last_seq: activity.lastSeq,
      activity_waiters: activity.subscribers,
    }),
  });

  // Every write goes through this app, so waking feed readers after each one covers them all.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.req.method !== 'OPTIONS') activity.wake();
  });

  app.post('/admin/reset', (c) => {
    store.reset();
    changes.reset();
    return c.json<ResetResult>({ ok: true, service: SERVICE, reset_at: new Date().toISOString() });
  });

  // ----- Activity feed (incidents + change requests, for programmatic watchers) -----

  app.get('/api/activity/tail', async (c) => {
    const p = parseQuery(c, activityTailSchema);
    const filter = activityFilter(p);
    const result = (items: ActivityTailResult['items'], cursor: number, hasMore: boolean) =>
      c.json<ActivityTailResult>({
        items,
        cursor,
        last_seq: activity.lastSeq,
        epoch: activity.epoch,
        has_more: hasMore,
      });
    if (p.after_seq === undefined) {
      return result(activity.latest(filter, p.limit), activity.lastSeq, false);
    }
    const deadline = Date.now() + p.wait_seconds * 1000;
    const signal = c.req.raw.signal;
    let after = p.after_seq;
    for (;;) {
      const r = activity.readAfter(after, filter, p.limit);
      after = r.cursor;
      const remaining = deadline - Date.now();
      if (r.items.length > 0 || remaining <= 0 || signal.aborted) {
        return result(r.items, r.cursor, r.hasMore);
      }
      await activity.waitForActivity(remaining, signal);
    }
  });

  app.get('/api/activity/stream', (c) => {
    const p = parseQuery(c, activityStreamSchema);
    const filter = activityFilter(p);
    const lastEventId = c.req.header('Last-Event-ID');
    let after =
      lastEventId && /^\d+$/.test(lastEventId)
        ? Number(lastEventId)
        : (p.after_seq ?? activity.lastSeq);
    const reqSignal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      const abort = () => ac.abort();
      stream.onAbort(abort);
      reqSignal.addEventListener('abort', abort, { once: true });
      try {
        let epoch = activity.epoch;
        await stream.write(`retry: 2000\n: connected last_seq=${activity.lastSeq}\n\n`);
        let lastWrite = Date.now();
        while (!ac.signal.aborted && !stream.aborted && !stream.closed) {
          if (activity.epoch !== epoch) {
            // Reset: seqs restarted. Skip the reseeded baseline and carry on live.
            epoch = activity.epoch;
            after = activity.lastSeq;
            await stream.writeSSE({ event: 'reset', data: JSON.stringify({ reset: true, epoch }) });
            lastWrite = Date.now();
          }
          const r = activity.readAfter(after, filter, 200);
          after = r.cursor;
          for (const event of r.items) {
            if (ac.signal.aborted) break;
            await stream.writeSSE({
              id: String(event.seq),
              event: 'activity',
              data: JSON.stringify(event),
            });
          }
          if (r.items.length > 0) lastWrite = Date.now();
          if (r.hasMore) continue;
          const idleFor = Date.now() - lastWrite;
          const woke = await activity.waitForActivity(
            Math.max(250, HEARTBEAT_MS - idleFor),
            ac.signal,
          );
          if (!woke && !ac.signal.aborted && Date.now() - lastWrite >= HEARTBEAT_MS - 250) {
            await stream.write(': heartbeat\n\n');
            lastWrite = Date.now();
          }
        }
      } finally {
        reqSignal.removeEventListener('abort', abort);
      }
    });
  });

  // ----- Incidents -----

  app.get('/api/incidents', (c) => {
    const query = parseQuery(c, incidentListSchema);
    const states = query.state?.flatMap((s) => {
      if (/^(open|active)$/i.test(s)) return ['new', 'in_progress', 'on_hold'] as IncidentState[];
      const parsed = stateValue.safeParse(s);
      if (!parsed.success) {
        throw badRequest(
          `Invalid state '${s}' (use ${INCIDENT_STATES.join(', ')}; comma separated)`,
        );
      }
      return [parsed.data];
    });
    const priorities = query.priority?.map((p) => {
      const n = Number(p.replace(/^p/i, ''));
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw badRequest(`Invalid priority '${p}' (use 1-5, comma separated)`);
      }
      return n as Priority;
    });
    const records = store.list({
      state: states,
      priority: priorities,
      active: query.active === undefined ? undefined : query.active === 'true',
      app_tla: query.app_tla,
      assignment_group: query.assignment_group,
      assigned_to: query.assigned_to,
      caller: query.caller,
      contact_type: csvEnum<ContactType>(query.contact_type, CONTACT_TYPES, 'contact_type'),
      category: query.category,
      parent_incident: query.parent_incident,
      relationship: query.relationship,
      q: query.q,
      opened_after: query.opened_after,
      opened_before: query.opened_before,
      sort: query.sort,
    });
    const page = paginate(records, query);
    return c.json({ ...page, items: page.items.map((r) => store.summary(r)) });
  });

  app.get('/api/incidents/:number', (c) =>
    c.json(store.full(store.require(c.req.param('number')))),
  );

  app.post('/api/incidents', async (c) => {
    const body = await parseBody(c, createSchema);
    return c.json(store.full(store.create(body)), 201);
  });

  app.patch('/api/incidents/:number', async (c) => {
    const body = await parseBody(c, updateSchema);
    const rec = store.update(c.req.param('number'), {
      ...body,
      add_links: body.add_links?.map((l) => ({ ...l, title: l.title || LINK_TYPE_LABELS[l.type] })),
    });
    return c.json(store.full(rec));
  });

  app.post('/api/incidents/:number/journal', async (c) => {
    const body = await parseBody(c, journalSchema);
    return c.json(store.addJournal(c.req.param('number'), body), 201);
  });

  app.post('/api/incidents/:number/children', async (c) => {
    const body = await parseBody(c, linkChildrenSchema);
    return c.json(store.full(store.linkChildren(c.req.param('number'), body)));
  });

  // ----- Change requests (QV → production through KBR) -----

  app.get('/api/change_requests', (c) => {
    const query = parseQuery(c, changeListSchema);
    const records = changes.list({
      state: csvEnum<ChangeState>(query.state, CHANGE_STATES, 'state'),
      type: csvEnum<ChangeType>(query.type, CHANGE_TYPES, 'type'),
      active: query.active === undefined ? undefined : query.active === 'true',
      app_tla: query.app_tla,
      project: query.project,
      merge_request: query.merge_request,
      requested_by: query.requested_by,
      related_incident: query.related_incident,
      q: query.q,
      implemented_after: query.implemented_after,
      implemented_before: query.implemented_before,
      planned_after: query.planned_after,
      planned_before: query.planned_before,
      sort: query.sort,
    });
    const page = paginate(records, query);
    return c.json({ ...page, items: page.items.map((r) => changes.summary(r)) });
  });

  app.get('/api/change_requests/:number', (c) =>
    c.json(changes.full(changes.require(c.req.param('number')))),
  );

  app.post('/api/change_requests', async (c) => {
    const body = await parseBody(c, changeCreateSchema);
    return c.json(changes.full(changes.create(body)), 201);
  });

  app.patch('/api/change_requests/:number', async (c) => {
    const body = await parseBody(c, changeUpdateSchema);
    return c.json(changes.full(changes.update(c.req.param('number'), body)));
  });

  app.post('/api/change_requests/:number/journal', async (c) => {
    const body = await parseBody(c, journalSchema);
    return c.json(changes.addJournal(c.req.param('number'), body), 201);
  });

  // Simulator only: KBR progress and imports with explicit timestamps.
  app.post('/admin/change_requests', async (c) => {
    const body = await parseBody(c, importSchema);
    return c.json(changes.full(changes.import(body)), 201);
  });

  app.post('/admin/change_requests/:number/release', async (c) => {
    const body = await parseBody(c, releaseSchema);
    return c.json(changes.full(changes.recordRelease(c.req.param('number'), body)));
  });

  // ----- CMDB: applications -----

  app.get('/api/apps', (c) => {
    const query = parseQuery(
      c,
      z.object({
        ...pageQuery,
        q: z.string().optional(),
        tier: z.coerce.number().int().min(1).max(3).optional(),
        business_unit: z.string().optional(),
        support_group: z.string().optional(),
      }),
    );
    const group = query.support_group
      ? dir.requireGroup(query.support_group, 'support_group')
      : undefined;
    const bu = query.business_unit?.trim().toLowerCase();
    const apps = dir.appsSorted.filter(
      (a) =>
        (!query.tier || a.tier === query.tier) &&
        (!bu || a.businessUnit.toLowerCase() === bu) &&
        (!group || a.supportGroupId === group.id) &&
        matchesQuery(query.q, [a.tla, a.name, a.description, a.businessUnit]),
    );
    // Rank: exact TLA, then name matches, then description/business unit matches.
    const q = query.q?.trim().toLowerCase();
    if (q) {
      const rank = (a: (typeof apps)[number]) =>
        a.tla.toLowerCase() === q ? 0 : matchesQuery(q, [a.tla, a.name]) ? 1 : 2;
      apps.sort((x, y) => rank(x) - rank(y) || x.tla.localeCompare(y.tla));
    }
    const page = paginate(apps, query);
    return c.json({ ...page, items: page.items.map((a) => dir.appSummary(a)) });
  });

  app.get('/api/apps/:tla', (c) => {
    const a = dir.findApp(c.req.param('tla'));
    if (!a)
      throw notFound(
        `Application ${c.req.param('tla')} not found (use a 3-letter TLA such as PAY)`,
      );
    return c.json(
      dir.appDetail(
        a,
        store.countOpen((r) => r.app_tla === a.tla),
      ),
    );
  });

  app.get('/api/apps/:tla/dependencies', (c) => {
    const a = dir.findApp(c.req.param('tla'));
    if (!a)
      throw notFound(
        `Application ${c.req.param('tla')} not found (use a 3-letter TLA such as PAY)`,
      );
    const query = parseQuery(
      c,
      z.object({
        direction: z.enum(['up', 'down', 'both']).default('both'),
        depth: z.coerce.number().int().min(1).max(5).default(1),
      }),
    );
    return c.json(dir.dependencies(a, query.direction, query.depth));
  });

  // ----- Groups -----

  app.get('/api/groups', (c) => {
    const query = parseQuery(
      c,
      z.object({
        ...pageQuery,
        q: z.string().optional(),
        type: z
          .enum(['app_support', 'noc', 'service_desk', 'incident_management', 'infrastructure'])
          .optional(),
      }),
    );
    const groups = dir.world.groups.filter(
      (g) =>
        (!query.type || g.type === query.type) &&
        matchesQuery(query.q, [g.id, g.name, g.description, g.email, ...g.appTlas]),
    );
    const page = paginate(groups, query);
    return c.json({ ...page, items: page.items.map((g) => dir.groupSummary(g)) });
  });

  app.get('/api/groups/:id', (c) => {
    const g = dir.findGroup(c.req.param('id'));
    if (!g) throw notFound(`Group ${c.req.param('id')} not found (use an id like grp_pay_support)`);
    return c.json(
      dir.groupDetail(
        g,
        store.countOpen((r) => r.assignment_group === g.id),
      ),
    );
  });

  // ----- Users -----

  app.get('/api/users', (c) => {
    const query = parseQuery(
      c,
      z.object({
        ...pageQuery,
        q: z.string().optional(),
        group: z.string().optional(),
        role: z.string().optional(),
      }),
    );
    const group = query.group ? dir.requireGroup(query.group, 'group') : undefined;
    const members = group ? new Set([...group.memberUsernames, group.managerUsername]) : undefined;
    const role = query.role?.trim().toLowerCase();
    const people = dir.peopleSorted.filter(
      (p) =>
        (!members || members.has(p.username)) &&
        (!role || p.role === role) &&
        matchesQuery(query.q, [p.name, p.username, p.email, p.title]),
    );
    const page = paginate(people, query);
    return c.json({ ...page, items: page.items.map((p) => dir.userSummary(p)) });
  });

  app.get('/api/users/:username', (c) => {
    const p = dir.findUser(c.req.param('username'));
    if (!p)
      throw notFound(`User ${c.req.param('username')} not found (use a username like dwhitfield)`);
    return c.json(
      dir.userDetail(
        p,
        store.countOpen((r) => r.assigned_to === p.username),
      ),
    );
  });

  return { app, store, changes, dir, activity };
}
