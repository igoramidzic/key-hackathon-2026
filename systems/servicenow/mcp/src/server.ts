import { URLS } from '@sim/contracts';
import {
  type AppTier,
  CLOSE_CODES,
  type CloseCode,
  CONTACT_TYPES,
  type ContactType,
  createServiceNowClient,
  INCIDENT_CATEGORIES,
  INCIDENT_STATES,
  type IncidentState,
  LINK_TYPES,
  type LinkType,
  type Priority,
} from '@sim/contracts/servicenow';
import { defineTool, type McpServerSpec, paginationShape, READ_ONLY, WRITE } from '@sim/mcp-kit';
import { z } from 'zod';
import {
  appFull,
  appRow,
  dependencyGraph,
  groupFull,
  groupRow,
  incidentFull,
  incidentRow,
  journalRow,
  userFull,
  userRow,
} from './format';

export const api = createServiceNowClient(process.env.SERVICENOW_API_URL ?? URLS.servicenow.api);

const BOT = 'svc_incident_auto';

const INSTRUCTIONS = `Simulated ServiceNow for KeyBank: ITSM incidents, the CMDB application catalog, support groups and people.

Data model
- Applications are identified by a TLA: a 3-letter uppercase code such as PAY, CIF or ATH. The same TLA names the GitLab group keybank/<TLA>00 (e.g. keybank/PAY00), the log label labels.app_tla in Cloud Logging, and app_tla on Moogsoft alerts. Each app has a tier (1 = most critical), an owner, exactly one support group, upstream apps (what it calls) and downstream apps (who calls it).
- Support groups own apps and hold the on-call rota (on_call.primary / on_call.secondary with phone and email), a manager and members. To find who supports an app: get_app → support_group. Shared groups: grp_noc (NOC), grp_service_desk, grp_mim (Major Incident Management), grp_dba, grp_network, grp_cloud, grp_middleware, grp_secops.
- People are identified by username (e.g. dwhitfield). Usernames are the same in ServiceNow, GitLab and Teams.
- Incidents are numbered INC0010001, INC0010002, ... Impact and urgency are 1 (High), 2 (Medium), 3 (Low); priority is derived and cannot be set: P1 = 1/1; P2 = 1/2 or 2/1; P3 = 1/3, 2/2 or 3/1; P4 = 2/3 or 3/2; P5 = 3/3. States: new → in_progress → on_hold (optional) → resolved → closed, or canceled. Resolving needs close_code + close_notes. Closed and canceled incidents are read-only except for notes.
- The journal holds work notes (internal), comments (visible to the caller) and system entries that record field changes.
- Writes act as svc_incident_auto (Incident Automation) unless you pass opened_by / updated_by / author.
- Every record has a web_url you can paste into Teams or elsewhere.`;

const stateEnum = z.enum(INCIDENT_STATES as [IncidentState, ...IncidentState[]]);
const level = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const impactShape = level.describe(
  'Impact: how widespread the effect is. 1 = High (many customers, branches or a critical business function), 2 = Medium (a group or one function), 3 = Low (a single user). Priority = derived from impact × urgency.',
);
const urgencyShape = level.describe(
  'Urgency: how quickly it must be fixed. 1 = High (business stopped, no workaround), 2 = Medium (degraded, workaround exists), 3 = Low (can wait).',
);
const userKey = (what: string) =>
  z.string().min(1).describe(`${what}: a username (e.g. dwhitfield), an email or a sys_id.`);
const groupKey = (what: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${what}: a group id (e.g. grp_pay_support) or the exact group name ("PAY Application Support").`,
    );
const tlaShape = z
  .string()
  .min(2)
  .max(5)
  .describe('Application TLA, the 3-letter app code, e.g. "PAY" (case-insensitive).');
const categoryShape = z
  .enum(INCIDENT_CATEGORIES as [string, ...string[]])
  .describe(`Incident category: ${INCIDENT_CATEGORIES.join(', ')}.`);
const linkShape = z.object({
  type: z
    .enum(LINK_TYPES as [LinkType, ...LinkType[]])
    .describe('teams_channel, merge_request, alert, log_query or other.'),
  url: z.url().describe('Absolute URL, e.g. http://localhost:3004/channels/<id>.'),
  title: z
    .string()
    .min(1)
    .describe(
      'Short label shown on the incident, e.g. "#inc-pay-500s" or "PAY00/payments-api!42".',
    ),
});

const numberShape = z
  .string()
  .min(1)
  .describe('Incident number, e.g. "INC0010042" (a sys_id also works).');

export const spec: McpServerSpec = {
  name: 'servicenow',
  title: 'ServiceNow (simulated)',
  version: '0.1.0',
  instructions: INSTRUCTIONS,
  register(server) {
    // ---------------------------------------------------------------------
    // Incidents
    // ---------------------------------------------------------------------

    defineTool(server, 'list_incidents', {
      title: 'List incidents',
      description:
        'Search incidents. Use it to check for existing or duplicate incidents on an app, see what is open for a group, or find recent history. Returns compact rows (number, priority 1-5, state, short_description, app_tla, assignment_group, assigned_to, opened_at, updated_at), newest first by default, plus total and next_cursor. Use get_incident for the full record and journal.',
      input: {
        state: z
          .array(stateEnum)
          .optional()
          .describe(
            'Only these states: new, in_progress, on_hold, resolved, closed, canceled. Example: ["new","in_progress"].',
          ),
        active: z
          .boolean()
          .optional()
          .describe(
            'true = open incidents (new, in_progress, on_hold); false = resolved, closed or canceled.',
          ),
        priority: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe('Only these priorities, 1 (Critical) to 5 (Planning). Example: [1,2].'),
        app_tla: tlaShape.optional(),
        assignment_group: groupKey('Assignment group').optional(),
        assigned_to: z
          .string()
          .optional()
          .describe('Assignee username, email or sys_id; "none" for unassigned incidents.'),
        caller: userKey('Caller').optional(),
        query: z
          .string()
          .optional()
          .describe(
            'Free text over number, short description, description and app (all words must match).',
          ),
        opened_after: z
          .string()
          .optional()
          .describe(
            'Only incidents opened after this time: relative ("30m", "24h", "7d") or ISO 8601.',
          ),
        sort: z
          .enum([
            '-opened_at',
            'opened_at',
            '-updated_at',
            'updated_at',
            'priority',
            '-priority',
            '-number',
            'number',
          ])
          .default('-opened_at')
          .describe(
            'Sort order. "-opened_at" (default) = newest first; "priority" = P1 first; "-updated_at" = recently updated first.',
          ),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ query, ...args }) => {
        const page = await api.listIncidents({
          ...args,
          priority: args.priority as Priority[] | undefined,
          q: query,
        });
        return {
          total: page.total,
          next_cursor: page.next_cursor,
          items: page.items.map(incidentRow),
        };
      },
    });

    defineTool(server, 'get_incident', {
      title: 'Get incident',
      description:
        'Full incident: fields, caller, assignment, resolution, related links (Teams channel, merge requests, alerts, log queries) and the journal (work notes, comments and system field changes, oldest first).',
      input: { number: numberShape },
      annotations: READ_ONLY,
      run: async ({ number }) => incidentFull(await api.getIncident(number)),
    });

    defineTool(server, 'create_incident', {
      title: 'Create incident',
      description:
        'Open a new incident (state new). Set app_tla to the affected application so the incident is tied to its CI. assignment_group is NOT inferred from the app: pass it explicitly (e.g. the app support group id from get_app). Priority is derived from impact × urgency (P1 = 1/1, P2 = 1/2 or 2/1, P3 = 1/3, 2/2 or 3/1, P4 = 2/3 or 3/2, P5 = 3/3). Check list_incidents for an existing open incident on the app first to avoid duplicates. Returns the full incident including number and web_url.',
      input: {
        short_description: z
          .string()
          .min(1)
          .max(160)
          .describe('One-line summary, e.g. "PAY - payment submissions failing with HTTP 500".'),
        description: z
          .string()
          .optional()
          .describe('Details: symptoms, impact, first seen, evidence (alert ids, log queries).'),
        app_tla: tlaShape.optional(),
        impact: impactShape.default(3),
        urgency: urgencyShape.default(3),
        category: categoryShape.default('application'),
        subcategory: z
          .string()
          .optional()
          .describe('Free text, e.g. "Software defect", "Integration".'),
        contact_type: z
          .enum(CONTACT_TYPES as [ContactType, ...ContactType[]])
          .default('monitoring')
          .describe(
            'How it was reported: monitoring (default), phone, email, self_service, chat, walk_in.',
          ),
        caller: userKey('Caller (who reported it; defaults to opened_by)').optional(),
        opened_by: userKey('Who opens it (default svc_incident_auto)').optional(),
        assignment_group: groupKey('Assignment group').optional(),
        assigned_to: userKey('Assignee (usually a member of the assignment group)').optional(),
      },
      annotations: WRITE,
      run: async (args) =>
        incidentFull(await api.openIncident({ ...args, opened_by: args.opened_by ?? BOT })),
    });

    defineTool(server, 'update_incident', {
      title: 'Update incident',
      description:
        'Change incident fields and, in the same call, add a work note, a customer-visible comment and related links. Only the fields you pass change; each change is recorded as a system journal entry ("State changed from New to In Progress"). Changing impact or urgency recalculates priority. To resolve: state "resolved" plus close_code and close_notes. Reassigning to another group clears an assignee who is not a member. Returns the full updated incident.',
      input: {
        number: numberShape,
        state: stateEnum
          .optional()
          .describe(
            'new, in_progress (being worked), on_hold (waiting on someone), resolved (fixed; needs close_code + close_notes), closed (final), canceled (raised in error or duplicate).',
          ),
        impact: impactShape.optional(),
        urgency: urgencyShape.optional(),
        assignment_group: groupKey('Assignment group (null clears it)')
          .nullable()
          .optional()
          .describe('Assignment group id (grp_cif_support) or exact name; null clears it.'),
        assigned_to: userKey('Assignee (null clears it)')
          .nullable()
          .optional()
          .describe(
            'Assignee username or email (usually a member of the assignment group); null clears it.',
          ),
        short_description: z.string().min(1).max(160).optional().describe('New one-line summary.'),
        description: z.string().optional().describe('Replaces the description.'),
        category: categoryShape.optional(),
        app_tla: tlaShape
          .nullable()
          .optional()
          .describe(
            'Re-point the incident to another application CI (e.g. the real culprit), or null.',
          ),
        close_code: z
          .enum(CLOSE_CODES as [CloseCode, ...CloseCode[]])
          .optional()
          .describe(`Resolution code, required when resolving: ${CLOSE_CODES.join(', ')}.`),
        close_notes: z
          .string()
          .optional()
          .describe(
            'Resolution notes, required when resolving: root cause and fix, e.g. "Reverted MR !42 in PAY00/payments-api".',
          ),
        work_note: z
          .string()
          .optional()
          .describe('Internal work note to add (not visible to the caller).'),
        comment: z
          .string()
          .optional()
          .describe('Customer-visible comment to add (visible to the caller).'),
        add_links: z
          .array(linkShape)
          .optional()
          .describe(
            'Related links to attach (duplicates by URL are ignored): Teams channel, GitLab MR, alert, log query.',
          ),
        updated_by: userKey('Who makes the change (default svc_incident_auto)').optional(),
      },
      annotations: WRITE,
      run: async ({ number, ...body }) =>
        incidentFull(
          await api.updateIncident(number, { ...body, updated_by: body.updated_by ?? BOT }),
        ),
    });

    defineTool(server, 'add_incident_note', {
      title: 'Add incident note',
      description:
        'Append a work note (internal, for IT) or a comment (visible to the caller) to an incident without changing fields. Works on closed incidents too. Returns the new journal entry.',
      input: {
        number: numberShape,
        text: z.string().min(1).describe('Note text. Plain text; newlines allowed.'),
        type: z
          .enum(['work_note', 'comment'])
          .default('work_note')
          .describe('work_note (internal, default) or comment (customer visible).'),
        author: userKey('Author (default svc_incident_auto)').optional(),
      },
      annotations: WRITE,
      run: async ({ number, text, type, author }) => {
        const entry = await api.addJournal(number, { type, text, author: author ?? BOT });
        return { number: number.toUpperCase(), entry: journalRow(entry) };
      },
    });

    // ---------------------------------------------------------------------
    // CMDB
    // ---------------------------------------------------------------------

    defineTool(server, 'search_apps', {
      title: 'Search applications',
      description:
        'Search the CMDB application catalog (400 apps) by TLA, name or description. Returns compact rows: tla, name, tier, criticality, business_unit and support_group. Use get_app for owner, on-call and dependencies.',
      input: {
        query: z
          .string()
          .optional()
          .describe('TLA or words from the name/description, e.g. "PAY", "wire", "fraud scoring".'),
        tier: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('1 = mission critical, 2 = business critical, 3 = other.'),
        business_unit: z
          .string()
          .optional()
          .describe('Exact business unit, e.g. "Payments", "Consumer Banking".'),
        support_group: groupKey('Only apps supported by this group').optional(),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ query, ...args }) => {
        const page = await api.listApps({
          ...args,
          tier: args.tier as AppTier | undefined,
          q: query,
        });
        return { total: page.total, next_cursor: page.next_cursor, items: page.items.map(appRow) };
      },
    });

    defineTool(server, 'get_app', {
      title: 'Get application',
      description:
        'Application (CI) by TLA: description, tier, criticality, owner, runtime (GKE service/namespace/cluster), GitLab group and repos, the support group with its manager, on-call primary/secondary (name, email, phone) and members, upstream apps it calls, downstream apps that call it (top 25 by tier), and the open incident count. This is how to find who supports and is on call for an app.',
      input: { tla: tlaShape },
      annotations: READ_ONLY,
      run: async ({ tla }) => appFull(await api.getApp(tla)),
    });

    defineTool(server, 'get_app_dependencies', {
      title: 'Get application dependencies',
      description:
        'Walk the dependency graph around an app. direction "up" = what it depends on (calls), "down" = what depends on it (its callers, i.e. blast radius), "both" = both. Returns nodes with depth (hops from the app), direction and support_group id, and edges as "A->B" meaning A calls B. Use it to find a shared upstream that several failing apps have in common, or who is impacted when an app fails.',
      input: {
        tla: tlaShape,
        direction: z
          .enum(['up', 'down', 'both'])
          .default('both')
          .describe('up, down or both (default).'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(1)
          .describe('How many hops to follow (1-5, default 1).'),
      },
      annotations: READ_ONLY,
      run: async ({ tla, direction, depth }) =>
        dependencyGraph(await api.getAppDependencies(tla, { direction, depth })),
    });

    // ---------------------------------------------------------------------
    // Groups and people
    // ---------------------------------------------------------------------

    defineTool(server, 'search_support_groups', {
      title: 'Search support groups',
      description:
        'Search assignment/support groups by name, id, description or supported TLA. Returns id, name, type, member and app counts, manager and on-call primary/secondary. Use get_support_group for contact details and members.',
      input: {
        query: z.string().optional().describe('Words or a TLA, e.g. "payments", "PAY", "network".'),
        type: z
          .enum(['app_support', 'noc', 'service_desk', 'incident_management', 'infrastructure'])
          .optional()
          .describe(
            'app_support, noc, service_desk, incident_management or infrastructure (DBA, network, cloud, middleware, security).',
          ),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ query, ...args }) => {
        const page = await api.listGroups({ ...args, q: query });
        return {
          total: page.total,
          next_cursor: page.next_cursor,
          items: page.items.map(groupRow),
        };
      },
    });

    defineTool(server, 'get_support_group', {
      title: 'Get support group',
      description:
        'Support group by id or exact name: description, email, manager, on-call primary and secondary (name, title, email, phone), all members with contact details, the apps it supports and its open incident count.',
      input: { group: groupKey('Group') },
      annotations: READ_ONLY,
      run: async ({ group }) => groupFull(await api.getGroup(group)),
    });

    defineTool(server, 'search_users', {
      title: 'Search people',
      description:
        'Search people by name, username, email or title, optionally within a group or role. Returns username, name, title, department and email.',
      input: {
        query: z
          .string()
          .optional()
          .describe('Words to match, e.g. "dana", "whitfield", "database administrator".'),
        group: groupKey('Only members (and the manager) of this group').optional(),
        role: z
          .enum([
            'engineer',
            'support',
            'manager',
            'infra',
            'noc',
            'service_desk',
            'incident_manager',
            'branch',
            'executive',
            'bot',
          ])
          .optional()
          .describe('Job role in the simulated bank.'),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ query, ...args }) => {
        const page = await api.listUsers({ ...args, q: query });
        return { total: page.total, next_cursor: page.next_cursor, items: page.items.map(userRow) };
      },
    });

    defineTool(server, 'get_user', {
      title: 'Get person',
      description:
        'Person by username (or email / sys_id): title, department, location, timezone, email, phone, manager, group memberships (with manager and on-call flags), apps they support through their groups, apps they own, and how many open incidents are assigned to them.',
      input: { username: userKey('Person') },
      annotations: READ_ONLY,
      run: async ({ username }) => userFull(await api.getUser(username)),
    });
  },
};
