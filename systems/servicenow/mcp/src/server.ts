import { URLS } from '@sim/contracts';
import {
  type AppTier,
  CHANGE_STATES,
  CHANGE_TYPES,
  type ChangeState,
  type ChangeType,
  CLOSE_CODES,
  type CloseCode,
  CONTACT_TYPES,
  type ContactType,
  createServiceNowClient,
  INCIDENT_CATEGORIES,
  INCIDENT_RELATIONSHIPS,
  INCIDENT_STATES,
  type IncidentRelationship,
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
  changeFull,
  changeRow,
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
- Parent and child incidents: when several incidents are really the same problem (several bankers calling about one outage, duplicates from monitoring), make one the parent and attach the rest as children: create_incident with child_incidents, or link_child_incidents later. One level only: a parent cannot be a child and a child cannot have children. Caller-visible comments on the parent are copied to its open children, and resolving or closing the parent resolves or closes its children with the same resolution. To find candidates: list_incidents with active, opened_after, contact_type ["phone","email","chat"] and relationship "standalone".
- Change requests (CHG0030001, ...) are how code reaches production. Merging an MR to main only deploys it to QV. A change request lists merged MRs of one application (keybank/<TLA>00 projects) and a planned_start; KBR (KeyBank Release, user svc_kbr) promotes every scheduled change once its planned start passes: it rolls the merge commits out to production, tags them kbr-<CHG>, notes each MR and closes the change (or sends it back to new with a note if an MR is not merged). States: new (draft) → scheduled → implement → closed, or canceled.
- For root cause, list_change_requests with app_tla and implemented_after shows what actually went to production and when; recent changes on the failing app or its upstream apps are prime suspects. To ship a fix: after a human merges the fix MR, create_change_request (type emergency, planned_start "now", related_incidents) so KBR promotes it.
- Writes act as svc_incident_auto (Incident Automation) unless you pass opened_by / updated_by / author / requested_by.
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
const incidentList = (what: string) =>
  z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe(`${what}: incident numbers, e.g. ["INC0010205","INC0010207"].`);
const contactTypeEnum = z.enum(CONTACT_TYPES as [ContactType, ...ContactType[]]);

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
        'Search incidents. Use it to check for existing or duplicate incidents on an app, find calls from staff about the same problem (contact_type, query, opened_after) that should be grouped under a parent, see what is open for a group, or find recent history. app_tla "none" finds incidents with no application. Returns compact rows (number, priority 1-5, state, short_description, app_tla, contact_type, caller, assignment_group, assigned_to, parent_incident, child_count, opened_at, updated_at), newest first by default, plus total and next_cursor. Use get_incident for the full record and journal.',
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
        contact_type: z
          .array(contactTypeEnum)
          .optional()
          .describe(
            'How they were reported: monitoring, phone, email, self_service, chat, walk_in. Example: ["phone","email"] for calls and mails from staff.',
          ),
        category: categoryShape.optional(),
        parent_incident: z
          .string()
          .optional()
          .describe('Only the children of this parent incident, e.g. "INC0010204".'),
        relationship: z
          .enum(INCIDENT_RELATIONSHIPS as [IncidentRelationship, ...IncidentRelationship[]])
          .optional()
          .describe(
            'parent (has child incidents), child (attached to a parent) or standalone (neither: not grouped yet).',
          ),
        query: z
          .string()
          .optional()
          .describe(
            'Free text over number, short description, description, app, caller name and caller location (all words must match), e.g. "teller date".',
          ),
        opened_after: z
          .string()
          .optional()
          .describe(
            'Only incidents opened after this time: relative ("30m", "24h", "7d") or ISO 8601.',
          ),
        opened_before: z
          .string()
          .optional()
          .describe('Only incidents opened before this time: relative ("10m") or ISO 8601.'),
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
        'Full incident: fields, caller, assignment, resolution, related links (Teams channel, merge requests, alerts, log queries), parent_incident and child_incidents, and the journal (work notes, comments and system field changes, oldest first).',
      input: { number: numberShape },
      annotations: READ_ONLY,
      run: async ({ number }) => incidentFull(await api.getIncident(number)),
    });

    defineTool(server, 'create_incident', {
      title: 'Create incident',
      description:
        'Open a new incident (state new). Set app_tla to the affected application so the incident is tied to its CI. assignment_group is NOT inferred from the app: pass it explicitly (e.g. the app support group id from get_app). Priority is derived from impact × urgency (P1 = 1/1, P2 = 1/2 or 2/1, P3 = 1/3, 2/2 or 3/1, P4 = 2/3 or 3/2, P5 = 3/3). Check list_incidents for an existing open incident on the app first to avoid duplicates. To group existing incidents that are the same problem (e.g. several bankers calling in), pass child_incidents: the new incident becomes their parent. Or pass parent_incident to attach the new one to an existing parent. Returns the full incident including number and web_url.',
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
        child_incidents: incidentList(
          'Existing incidents that are the same problem; they become children of the new incident',
        ).optional(),
        parent_incident: z
          .string()
          .optional()
          .describe('Attach the new incident as a child of this open parent, e.g. "INC0010204".'),
      },
      annotations: WRITE,
      run: async (args) =>
        incidentFull(await api.openIncident({ ...args, opened_by: args.opened_by ?? BOT })),
    });

    defineTool(server, 'update_incident', {
      title: 'Update incident',
      description:
        'Change incident fields and, in the same call, add a work note, a customer-visible comment and related links. Only the fields you pass change; each change is recorded as a system journal entry ("State changed from New to In Progress"). Changing impact or urgency recalculates priority. To resolve: state "resolved" plus close_code and close_notes; on a parent this also resolves its open children with the same resolution, and a comment on a parent is copied to its open children. parent_incident attaches the incident to a parent (null detaches it). Reassigning to another group clears an assignee who is not a member. Returns the full updated incident.',
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
        parent_incident: z
          .string()
          .nullable()
          .optional()
          .describe('Parent incident number to attach this incident to, or null to detach it.'),
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
        'Append a work note (internal, for IT) or a comment (visible to the caller) to an incident without changing fields. A comment on a parent incident is copied to its open children, so every caller sees it. Works on closed incidents too. Returns the new journal entry.',
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

    defineTool(server, 'link_child_incidents', {
      title: 'Link child incidents',
      description:
        'Group incidents that are the same problem under one parent: each child gets parent_incident set and a system entry, and the parent lists them. Use it when several people call in about one outage, or monitoring and the service desk both opened incidents for it. One level only (a parent cannot be a child; a child cannot have children); the parent must be open. Afterwards, comments on the parent reach every caller, and resolving the parent resolves the children. Already-linked children are skipped. Returns the parent incident with its child_incidents.',
      input: {
        parent: numberShape.describe('Parent incident number, e.g. "INC0010204".'),
        children: incidentList('Incidents to attach as children'),
        work_note: z
          .string()
          .optional()
          .describe('Internal note on the parent, e.g. why they are the same problem.'),
        child_comment: z
          .string()
          .optional()
          .describe(
            'Caller-visible comment added to each newly linked child, e.g. "This is a known outage tracked in INC0010204; we will update you here."',
          ),
        updated_by: userKey('Who links them (default svc_incident_auto)').optional(),
      },
      annotations: WRITE,
      run: async ({ parent, ...body }) =>
        incidentFull(
          await api.linkChildren(parent, { ...body, updated_by: body.updated_by ?? BOT }),
        ),
    });

    // ---------------------------------------------------------------------
    // Change requests (QV → production through KBR)
    // ---------------------------------------------------------------------

    const changeNumberShape = z
      .string()
      .min(1)
      .describe('Change request number, e.g. "CHG0030042" (a sys_id also works).');
    const mrRefs = z
      .array(z.string().min(1))
      .describe(
        'Merge requests to promote, each "keybank/<TLA>00/<repo>!<iid>" (e.g. "keybank/CIF00/customer-profile-api!42") or the MR web_url. All must be in the application\'s GitLab group.',
      );
    const plannedStartShape = z
      .string()
      .min(1)
      .describe(
        'When KBR promotes it to production: "now", an offset like "+30m" or "in 2h", or an ISO time such as "2026-11-11T22:00:00Z".',
      );

    defineTool(server, 'list_change_requests', {
      title: 'List change requests',
      description:
        'Search change requests: what was (or will be) promoted from QV to production by KBR. Use it during root-cause analysis to see what actually reached production on an app and its upstream apps (app_tla + implemented_after "6h"), to find which change shipped a given MR (merge_request), or to see what is scheduled next (state ["scheduled"], sort "planned_start"). Returns compact rows (number, state, type, short_description, app_tla, projects, requested_by, planned_start, implemented_at, release, related_incidents, web_url) plus total and next_cursor; newest first by default. get_change_request has the MRs, deployed versions and journal.',
      input: {
        state: z
          .array(z.enum(CHANGE_STATES as [ChangeState, ...ChangeState[]]))
          .optional()
          .describe('Only these states: new, scheduled, implement, closed, canceled.'),
        type: z
          .array(z.enum(CHANGE_TYPES as [ChangeType, ...ChangeType[]]))
          .optional()
          .describe('Only these types: normal, standard, emergency.'),
        active: z
          .boolean()
          .optional()
          .describe('true = new, scheduled or implement; false = closed or canceled.'),
        app_tla: tlaShape.optional(),
        project: z
          .string()
          .optional()
          .describe('GitLab project path, e.g. "keybank/CIF00/customer-profile-api".'),
        merge_request: z
          .string()
          .optional()
          .describe(
            'Changes containing this MR: "keybank/CIF00/customer-profile-api!42" or its URL.',
          ),
        requested_by: userKey('Requester').optional(),
        related_incident: z.string().optional().describe('Changes linked to this incident number.'),
        query: z.string().optional().describe('Free text over number, description and MR titles.'),
        implemented_after: z
          .string()
          .optional()
          .describe('Promoted to production at or after this time: ISO or relative ("6h", "2d").'),
        implemented_before: z.string().optional().describe('ISO or relative ("1h").'),
        planned_after: z
          .string()
          .optional()
          .describe('Planned start at or after (ISO or relative).'),
        planned_before: z
          .string()
          .optional()
          .describe('Planned start at or before (ISO or relative).'),
        sort: z
          .enum([
            '-opened_at',
            'opened_at',
            '-implemented_at',
            'implemented_at',
            'planned_start',
            '-planned_start',
            'number',
            '-number',
          ])
          .default('-opened_at')
          .describe(
            '"-opened_at" (default) newest first; "-implemented_at" most recently promoted first; "planned_start" next KBR run first.',
          ),
        ...paginationShape,
      },
      annotations: READ_ONLY,
      run: async ({ query, ...args }) => {
        const page = await api.listChanges({ ...args, q: query });
        return {
          total: page.total,
          next_cursor: page.next_cursor,
          items: page.items.map(changeRow),
        };
      },
    });

    defineTool(server, 'get_change_request', {
      title: 'Get change request',
      description:
        "Full change request: application, merge requests (reference, title, state, merge commit), what KBR deployed (project, service, sha, version, GitLab tag, time), the KBR release id and status, related incidents, planned start, close notes and the journal (including KBR's notes when it aborts, e.g. an MR that was not merged).",
      input: { number: changeNumberShape },
      annotations: READ_ONLY,
      run: async ({ number }) => changeFull(await api.getChange(number)),
    });

    defineTool(server, 'create_change_request', {
      title: 'Create change request',
      description:
        'Raise a change request to promote merged MRs of one application from QV to production. With planned_start it is scheduled right away and KBR runs it once that time passes (within seconds for "now"); without it the change stays a draft (state new). KBR only promotes MRs that are merged to main: if one is not, it aborts and puts the change back to new with a note, so merge first (a human does that in the GitLab UI). For an incident fix use type "emergency", planned_start "now" and related_incidents; KBR then adds a work note to each incident when the fix is live. Returns the full change with number and web_url.',
      input: {
        short_description: z
          .string()
          .min(1)
          .max(160)
          .describe('One line, e.g. "CIF - revert naming strategy change (INC0010205)".'),
        app_tla: tlaShape.describe(
          'Application being changed, e.g. "CIF" (its GitLab group keybank/CIF00).',
        ),
        merge_requests: mrRefs.min(1).max(50),
        planned_start: plannedStartShape.optional(),
        type: z
          .enum(CHANGE_TYPES as [ChangeType, ...ChangeType[]])
          .default('normal')
          .describe('normal (CAB), standard (pre-approved) or emergency (fixes a live incident).'),
        risk: z
          .enum(['low', 'moderate', 'high'])
          .optional()
          .describe('Default moderate (high for emergency).'),
        description: z.string().optional().describe('What changes and why; evidence for a fix.'),
        justification: z.string().optional().describe('Business reason, e.g. the incident impact.'),
        backout_plan: z
          .string()
          .optional()
          .describe('How to roll back (default: KBR rollback release).'),
        related_incidents: incidentList('Incidents this change fixes').max(20).optional(),
        requested_by: userKey('Requester (default svc_incident_auto)').optional(),
        assignment_group: groupKey(
          'Implementing group (default: the app support group)',
        ).optional(),
      },
      annotations: WRITE,
      run: async (args) =>
        changeFull(await api.createChange({ ...args, requested_by: args.requested_by ?? BOT })),
    });

    defineTool(server, 'update_change_request', {
      title: 'Update change request',
      description:
        'Edit a draft or scheduled change: reschedule (planned_start; on a draft this also schedules it), add merge requests, cancel (state "canceled"), link incidents, or add a work note. Use it to retry after KBR aborted a change (merge the MR, then set planned_start "now"). Once KBR has implemented or closed it only work notes and related incidents can be added; raise a new change instead. Returns the full change.',
      input: {
        number: changeNumberShape,
        state: z
          .enum(['new', 'scheduled', 'canceled'])
          .optional()
          .describe('scheduled (needs a planned_start), new (back to draft) or canceled.'),
        planned_start: plannedStartShape.optional(),
        add_merge_requests: mrRefs.max(50).optional(),
        related_incidents: incidentList('Incidents to link').max(20).optional(),
        short_description: z.string().min(1).max(160).optional().describe('New one-line summary.'),
        description: z.string().optional().describe('Replaces the description.'),
        type: z
          .enum(CHANGE_TYPES as [ChangeType, ...ChangeType[]])
          .optional()
          .describe('normal, standard or emergency.'),
        work_note: z.string().optional().describe('Internal work note to add.'),
        updated_by: userKey('Who makes the change (default svc_incident_auto)').optional(),
      },
      annotations: WRITE,
      run: async ({ number, ...body }) =>
        changeFull(await api.updateChange(number, { ...body, updated_by: body.updated_by ?? BOT })),
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
