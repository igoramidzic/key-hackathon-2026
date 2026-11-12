import { badRequest, conflict, notFound, parseTime } from '@sim/api-kit';
import {
  CONTACT_TYPE_LABELS,
  type CommunicationSummary,
  type ContactType,
  type FieldChange,
  IMPACT_LABELS,
  type Incident,
  type IncidentCreateInput,
  type IncidentRelationship,
  type IncidentSort,
  type IncidentState,
  type IncidentSummary,
  type IncidentUpdateInput,
  isActiveState,
  type JournalEntry,
  type JournalInput,
  type JournalType,
  type LinkChildrenInput,
  PRIORITY_LABELS,
  priorityFor,
  STATE_LABELS,
  serviceNowWebUrl,
} from '@sim/contracts/servicenow';
import { sysId } from '@sim/world';
import { type Directory, matchesQuery } from './directory';
import {
  clip,
  DEFAULT_ACTOR,
  emptyResolution,
  FIRST_NUMBER,
  type IdGen,
  type IncidentRecord,
  incidentNumber,
  type JournalRecord,
  type LinkRecord,
  minutesBetween,
  parseWhen,
} from './model';
import { seedIncidents } from './seed';

export interface IncidentFilter {
  state?: IncidentState[];
  priority?: number[];
  active?: boolean;
  app_tla?: string;
  assignment_group?: string;
  assigned_to?: string;
  caller?: string;
  contact_type?: ContactType[];
  category?: string;
  parent_incident?: string;
  relationship?: IncidentRelationship;
  q?: string;
  opened_after?: string;
  opened_before?: string;
  sort?: IncidentSort;
}

/**
 * What the stores built on top of this one know about an incident. `buildApp` wires these once
 * those stores exist (they take this store in their constructor, so it cannot import them).
 */
export interface IncidentRelations {
  /** The canonical CHG number, or undefined when there is no such change request. */
  changeNumber?: (key: string) => string | undefined;
  /** Critical Incident Communications of an incident, oldest first. */
  communications?: (incident: string) => CommunicationSummary[];
}

/** Internal options for `update` (not part of the API). */
interface UpdateOptions {
  /** Skip the "child incident added/removed" entry on the parent (linkChildren writes one). */
  quietParent?: boolean;
}

const CATEGORY_ALIASES: Record<string, string> = {
  software: 'application',
  app: 'application',
  batch: 'batch_job',
  batch_jobs: 'batch_job',
  db: 'database',
  security: 'access',
  inquiry_help: 'inquiry',
  help: 'inquiry',
};

export function normalizeCategory(value: string): string {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_')
    .replace(/_+/g, '_');
  return CATEGORY_ALIASES[key] ?? key;
}

const FIELD_LABELS: Record<string, string> = {
  state: 'State',
  impact: 'Impact',
  urgency: 'Urgency',
  priority: 'Priority',
  assignment_group: 'Assignment group',
  assigned_to: 'Assigned to',
  short_description: 'Short description',
  description: 'Description',
  category: 'Category',
  subcategory: 'Subcategory',
  app_tla: 'Configuration item',
  caller: 'Caller',
  contact_type: 'Contact type',
  close_code: 'Resolution code',
  close_notes: 'Resolution notes',
  parent_incident: 'Parent Incident',
  child_incidents: 'Child incidents',
  links: 'Related link',
  affected_cis: 'Affected CIs',
  outage_start: 'Outage start',
  service_restored_at: 'Service restored',
  cause_code: 'Cause code',
  caused_by_change: 'Caused by change',
  resolved_by_change: 'Resolved by change',
  root_cause: 'Root cause',
  client_impact: 'Impact to clients',
  employee_impact: 'Impact to employees',
  problem: 'Problem',
};

/** Paragraph fields: the journal records a one-line preview, not the whole text. */
const LONG_TEXT_FIELDS = ['root_cause', 'client_impact', 'employee_impact'] as const;
const isLongText = (field: string) => (LONG_TEXT_FIELDS as readonly string[]).includes(field);

/** "State changed from New to In Progress" lines for a system journal entry. */
export function describeChanges(changes: FieldChange[]): string {
  return changes
    .map((c) => {
      if (c.field === 'links') return `Related link added: ${c.to}`;
      if (c.field === 'description') return 'Description updated';
      if (c.field === 'close_notes') return `Resolution notes set: ${c.to ?? '(empty)'}`;
      if (isLongText(c.field))
        return c.to === null ? `${c.label} cleared` : `${c.label} set: ${c.to}`;
      return `${c.label} changed from ${c.from ?? '(empty)'} to ${c.to ?? '(empty)'}`;
    })
    .join('\n');
}

export class IncidentStore {
  records: IncidentRecord[] = [];
  private byKey = new Map<string, IncidentRecord>();
  private nextNumber = FIRST_NUMBER;
  private journalSeq = 0;
  private linkSeq = 0;
  /** Changes on every reset (journal seqs restart), so feed readers can tell. */
  epoch = 0;
  readonly ids: IdGen = {
    journal: () => `jrn_${String(++this.journalSeq).padStart(6, '0')}`,
    link: () => `lnk_${String(++this.linkSeq).padStart(5, '0')}`,
  };

  /** Wired by `buildApp`: change request lookups and the communications of an incident. */
  relations: IncidentRelations = {};

  constructor(private readonly dir: Directory) {
    this.reset();
  }

  /** Restores the seeded baseline (timestamps relative to now). */
  reset(now = new Date()) {
    this.epoch = Math.max(now.getTime(), this.epoch + 1);
    this.journalSeq = 0;
    this.linkSeq = 0;
    this.records = seedIncidents(this.dir, now, this.ids);
    this.byKey.clear();
    for (const rec of this.records) this.index(rec);
    // New incidents continue after the highest seeded number.
    this.nextNumber =
      Math.max(FIRST_NUMBER - 1, ...this.records.map((r) => Number(r.number.slice(3)))) + 1;
  }

  /** Seq of the newest journal entry on any incident or change request (shared generator). */
  get lastJournalSeq() {
    return this.journalSeq;
  }

  private index(rec: IncidentRecord) {
    this.byKey.set(rec.number, rec);
    this.byKey.set(rec.sys_id, rec);
  }

  find(key: string): IncidentRecord | undefined {
    const k = key.trim();
    return this.byKey.get(k.toUpperCase()) ?? this.byKey.get(k.toLowerCase());
  }

  require(key: string): IncidentRecord {
    const rec = this.find(key);
    if (!rec)
      throw notFound(`Incident ${key} not found (use an INC number like INC0010042 or a sys_id)`);
    return rec;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(filter: IncidentFilter): IncidentRecord[] {
    const states = filter.state ? new Set(filter.state) : undefined;
    const priorities = filter.priority ? new Set(filter.priority) : undefined;
    const tla = filter.app_tla?.trim().toUpperCase();
    const group = filter.assignment_group
      ? this.dir.requireGroup(filter.assignment_group, 'assignment_group').id
      : undefined;
    const unassigned = filter.assigned_to?.toLowerCase() === 'none';
    const assignee =
      filter.assigned_to && !unassigned
        ? this.dir.requireUser(filter.assigned_to, 'assigned_to').username
        : undefined;
    const caller = filter.caller
      ? this.dir.requireUser(filter.caller, 'caller').username
      : undefined;
    const after = parseTime(filter.opened_after)?.toISOString();
    const before = parseTime(filter.opened_before)?.toISOString();
    const noApp = tla === 'NONE';
    const contactTypes = filter.contact_type ? new Set(filter.contact_type) : undefined;
    const category = filter.category ? normalizeCategory(filter.category) : undefined;
    const parent = filter.parent_incident ? this.require(filter.parent_incident).number : undefined;
    const counts = this.childCounts();

    const out = this.records.filter((r) => {
      if (states && !states.has(r.state)) return false;
      if (priorities && !priorities.has(priorityFor(r.impact, r.urgency))) return false;
      if (filter.active !== undefined && isActiveState(r.state) !== filter.active) return false;
      if (noApp ? r.app_tla !== null : tla && r.app_tla !== tla) return false;
      if (contactTypes && !contactTypes.has(r.contact_type)) return false;
      if (category && r.category !== category) return false;
      if (parent && r.parent_incident !== parent) return false;
      if (filter.relationship) {
        const relationship = r.parent_incident
          ? 'child'
          : counts.get(r.number)
            ? 'parent'
            : 'standalone';
        if (relationship !== filter.relationship) return false;
      }
      if (group && r.assignment_group !== group) return false;
      if (unassigned && r.assigned_to) return false;
      if (assignee && r.assigned_to !== assignee) return false;
      if (caller && r.caller !== caller) return false;
      if (after && r.opened_at < after) return false;
      if (before && r.opened_at >= before) return false;
      if (filter.q) {
        const app = r.app_tla ? this.dir.world.appsByTla.get(r.app_tla) : undefined;
        const who = r.caller ? this.dir.world.peopleByUsername.get(r.caller) : undefined;
        if (
          !matchesQuery(filter.q, [
            r.number,
            r.short_description,
            r.description,
            r.app_tla,
            app?.name,
            who?.name,
            who?.location,
          ])
        ) {
          return false;
        }
      }
      return true;
    });
    return sortRecords(out, filter.sort ?? '-opened_at');
  }

  isOpen(r: IncidentRecord) {
    return isActiveState(r.state);
  }

  /** Children of an incident, oldest first. */
  childrenOf(number: string): IncidentRecord[] {
    return this.records
      .filter((r) => r.parent_incident === number)
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.number.localeCompare(b.number));
  }

  private childCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      if (r.parent_incident)
        counts.set(r.parent_incident, (counts.get(r.parent_incident) ?? 0) + 1);
    }
    return counts;
  }

  /** Throws unless `parent` can take child incidents. */
  private assertCanBeParent(parent: IncidentRecord, child: string) {
    if (parent.parent_incident) {
      throw conflict(
        `${parent.number} is itself a child of ${parent.parent_incident}. Link ${child} to ${parent.parent_incident} instead (only one level of parent and child).`,
      );
    }
    if (!isActiveState(parent.state)) {
      throw conflict(
        `Parent ${parent.number} is ${STATE_LABELS[parent.state]}. Only an open incident (New, In Progress or On Hold) can take child incidents.`,
      );
    }
  }

  /** Throws unless `child` can be attached to a parent. */
  private assertCanBeChild(child: IncidentRecord, parent: string) {
    const kids = this.childrenOf(child.number);
    if (kids.length > 0) {
      throw conflict(
        `${child.number} is the parent of ${kids.map((k) => k.number).join(', ')} and cannot become a child. Link those incidents to ${parent} directly, or make ${child.number} the parent.`,
      );
    }
    if (child.state === 'closed' || child.state === 'canceled') {
      throw conflict(
        `${child.number} is ${STATE_LABELS[child.state]} and can no longer be linked to a parent.`,
      );
    }
  }

  /** Throws unless `child` may become a child of `parent`. */
  private assertCanLink(child: IncidentRecord, parent: IncidentRecord) {
    if (child.number === parent.number) {
      throw badRequest(`${child.number} cannot be its own parent.`);
    }
    this.assertCanBeParent(parent, child.number);
    this.assertCanBeChild(child, parent.number);
  }

  countOpen(predicate: (r: IncidentRecord) => boolean): number {
    let n = 0;
    for (const r of this.records) if (isActiveState(r.state) && predicate(r)) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  create(input: IncidentCreateInput, now = new Date()): IncidentRecord {
    if (input.parent_incident && input.child_incidents?.length) {
      throw badRequest(
        'Pass parent_incident or child_incidents, not both (only one level of parent and child).',
      );
    }
    // Validate links before creating anything, so a bad number doesn't leave a half-made record.
    const parent = input.parent_incident ? this.require(input.parent_incident) : undefined;
    if (parent) this.assertCanBeParent(parent, 'the new incident');
    const children = [...new Set((input.child_incidents ?? []).map((k) => this.require(k)))];
    for (const child of children) this.assertCanBeChild(child, 'the new incident');
    const openedBy = this.dir.requireUser(input.opened_by ?? DEFAULT_ACTOR, 'opened_by').username;
    const caller = input.caller ? this.dir.requireUser(input.caller, 'caller').username : openedBy;
    const app = input.app_tla ? this.dir.requireApp(input.app_tla).tla : null;
    const group = input.assignment_group
      ? this.dir.requireGroup(input.assignment_group, 'assignment_group').id
      : null;
    const assignee = input.assigned_to
      ? this.dir.requireUser(input.assigned_to, 'assigned_to').username
      : null;
    const affected = this.affectedCis(input.affected_cis ?? [], app);
    const outageStart = input.outage_start
      ? parseWhen(input.outage_start, 'outage_start', now)
      : null;
    const at = now.toISOString();
    const n = this.nextNumber++;
    const number = incidentNumber(n);
    const rec: IncidentRecord = {
      sys_id: sysId(`incident:${number}`),
      number,
      short_description: input.short_description.trim(),
      description: input.description?.trim() ?? '',
      state: 'new',
      impact: input.impact ?? 3,
      urgency: input.urgency ?? 3,
      category: input.category ? normalizeCategory(input.category) : 'application',
      subcategory: input.subcategory?.trim() || null,
      app_tla: app,
      caller,
      opened_by: openedBy,
      contact_type: input.contact_type ?? 'monitoring',
      assignment_group: group,
      assigned_to: assignee,
      opened_at: at,
      updated_at: at,
      updated_by: openedBy,
      resolved_at: null,
      resolved_by: null,
      closed_at: null,
      close_code: null,
      close_notes: null,
      reassignment_count: 0,
      reopen_count: 0,
      parent_incident: null,
      ...emptyResolution(),
      affected_cis: affected,
      outage_start: outageStart,
      links: [],
      journal: [],
    };
    rec.journal.push({
      id: this.ids.journal(),
      type: 'system',
      text: `Incident opened via ${CONTACT_TYPE_LABELS[rec.contact_type] ?? rec.contact_type}`,
      author: openedBy,
      created_at: at,
      changes: this.initialValues(rec),
    });
    this.records.push(rec);
    this.index(rec);
    if (parent)
      this.update(rec.number, { parent_incident: parent.number, updated_by: openedBy }, now);
    if (children.length > 0) {
      this.linkChildren(
        rec.number,
        { children: children.map((c) => c.number), updated_by: openedBy },
        now,
      );
    }
    return rec;
  }

  /** Attaches incidents as children of `parentKey` (one system entry on the parent). */
  linkChildren(parentKey: string, input: LinkChildrenInput, now = new Date()): IncidentRecord {
    const parent = this.require(parentKey);
    const actor = this.dir.requireUser(input.updated_by ?? DEFAULT_ACTOR, 'updated_by').username;
    const at = now.toISOString();
    if (input.children.length === 0) throw badRequest('children must list at least one incident.');
    const children = [...new Set(input.children.map((k) => this.require(k)))];
    for (const child of children) {
      if (child.parent_incident !== parent.number) this.assertCanLink(child, parent);
    }
    const added: string[] = [];
    for (const child of children) {
      if (child.parent_incident === parent.number) continue;
      this.update(
        child.number,
        { parent_incident: parent.number, comment: input.child_comment, updated_by: actor },
        now,
        { quietParent: true },
      );
      added.push(child.number);
    }
    if (added.length > 0) {
      parent.journal.push({
        id: this.ids.journal(),
        type: 'system',
        text: `Child incidents added: ${added.join(', ')}`,
        author: actor,
        created_at: at,
        changes: added.map((n) => ({
          field: 'child_incidents',
          label: FIELD_LABELS.child_incidents!,
          from: null,
          to: n,
        })),
      });
    }
    if (input.work_note?.trim())
      parent.journal.push(this.entry('work_note', input.work_note, actor, at));
    if (added.length > 0 || input.work_note?.trim()) {
      parent.updated_at = at;
      parent.updated_by = actor;
    }
    return parent;
  }

  /** Field values shown on the "Incident opened" activity entry. */
  initialValues(rec: IncidentRecord): FieldChange[] {
    const fields: [string, string | null][] = [
      ['state', STATE_LABELS[rec.state]],
      ['priority', PRIORITY_LABELS[priorityFor(rec.impact, rec.urgency)]],
      ['impact', IMPACT_LABELS[rec.impact]],
      ['urgency', IMPACT_LABELS[rec.urgency]],
      ['app_tla', rec.app_tla ? this.dir.appDisplay(rec.app_tla) : null],
      [
        'assignment_group',
        rec.assignment_group ? this.dir.groupRef(rec.assignment_group).name : null,
      ],
      ['assigned_to', rec.assigned_to ? this.dir.userRef(rec.assigned_to).name : null],
      ['affected_cis', rec.affected_cis.join(', ') || null],
      ['outage_start', rec.outage_start],
    ];
    return fields
      .filter(([, v]) => v !== null)
      .map(([field, to]) => ({ field, label: FIELD_LABELS[field]!, from: null, to }));
  }

  update(
    key: string,
    input: IncidentUpdateInput,
    now = new Date(),
    options: UpdateOptions = {},
  ): IncidentRecord {
    const rec = this.require(key);
    const actor = this.dir.requireUser(input.updated_by ?? DEFAULT_ACTOR, 'updated_by').username;
    const at = now.toISOString();

    const next = { ...rec };
    if (input.state !== undefined) next.state = input.state;
    if (input.impact !== undefined) next.impact = input.impact;
    if (input.urgency !== undefined) next.urgency = input.urgency;
    if (input.short_description !== undefined)
      next.short_description = input.short_description.trim();
    if (input.description !== undefined) next.description = input.description.trim();
    if (input.category !== undefined) next.category = normalizeCategory(input.category);
    if (input.subcategory !== undefined) next.subcategory = input.subcategory?.trim() || null;
    if (input.contact_type !== undefined) next.contact_type = input.contact_type;
    if (input.app_tla !== undefined) {
      next.app_tla = input.app_tla ? this.dir.requireApp(input.app_tla).tla : null;
    }
    if (input.caller !== undefined) {
      next.caller = input.caller ? this.dir.requireUser(input.caller, 'caller').username : null;
    }
    if (input.assignment_group !== undefined) {
      next.assignment_group = input.assignment_group
        ? this.dir.requireGroup(input.assignment_group, 'assignment_group').id
        : null;
    }
    if (input.assigned_to !== undefined) {
      next.assigned_to = input.assigned_to
        ? this.dir.requireUser(input.assigned_to, 'assigned_to').username
        : null;
    } else if (next.assignment_group !== rec.assignment_group && next.assigned_to) {
      // Like ServiceNow: moving to another group clears an assignee who isn't in it.
      const g = next.assignment_group
        ? this.dir.world.groupsById.get(next.assignment_group)
        : undefined;
      if (!g?.memberUsernames.includes(next.assigned_to)) next.assigned_to = null;
    }
    if (input.close_code !== undefined) next.close_code = input.close_code;
    if (input.close_notes !== undefined) next.close_notes = input.close_notes.trim();
    if (input.affected_cis !== undefined || next.app_tla !== rec.app_tla) {
      // The configuration item itself is never listed as an affected CI.
      const cis = this.affectedCis(input.affected_cis ?? rec.affected_cis, next.app_tla);
      if (cis.join() !== rec.affected_cis.join()) next.affected_cis = cis;
    }
    if (input.outage_start !== undefined) {
      next.outage_start =
        input.outage_start === null ? null : parseWhen(input.outage_start, 'outage_start', now);
    }
    if (input.service_restored_at !== undefined) {
      next.service_restored_at =
        input.service_restored_at === null
          ? null
          : parseWhen(input.service_restored_at, 'service_restored_at', now);
    }
    if (input.cause_code !== undefined) next.cause_code = input.cause_code;
    if (input.caused_by_change !== undefined) {
      next.caused_by_change =
        input.caused_by_change === null
          ? null
          : this.changeRef(input.caused_by_change, 'caused_by_change');
    }
    if (input.resolved_by_change !== undefined) {
      next.resolved_by_change =
        input.resolved_by_change === null
          ? null
          : this.changeRef(input.resolved_by_change, 'resolved_by_change');
    }
    for (const field of LONG_TEXT_FIELDS) {
      const value = input[field];
      if (value !== undefined) next[field] = value?.trim() || null;
    }
    const oldParent = rec.parent_incident;
    if (input.parent_incident !== undefined) {
      if (input.parent_incident === null) {
        next.parent_incident = null;
      } else {
        const parent = this.require(input.parent_incident);
        if (parent.number !== rec.parent_incident) this.assertCanLink(rec, parent);
        next.parent_incident = parent.number;
      }
    }

    const fieldChanged = (
      [
        'state',
        'impact',
        'urgency',
        'short_description',
        'description',
        'category',
        'subcategory',
        'contact_type',
        'app_tla',
        'caller',
        'assignment_group',
        'assigned_to',
        'close_code',
        'close_notes',
        'parent_incident',
        'affected_cis',
        'outage_start',
        'service_restored_at',
        'cause_code',
        'caused_by_change',
        'resolved_by_change',
        'root_cause',
        'client_impact',
        'employee_impact',
      ] as const
    ).filter((f) => next[f] !== rec[f]);

    if (fieldChanged.length > 0 && (rec.state === 'closed' || rec.state === 'canceled')) {
      throw conflict(
        `${rec.number} is ${STATE_LABELS[rec.state]} and its fields can no longer be changed. ` +
          'Open a new incident instead (notes can still be added).',
      );
    }

    const wasResolved = rec.state === 'resolved' || rec.state === 'closed';
    const resolving = (next.state === 'resolved' || next.state === 'closed') && !wasResolved;
    if (resolving && (!next.close_code || !next.close_notes)) {
      throw badRequest(
        `close_code and close_notes are required to move ${rec.number} to ${STATE_LABELS[next.state]}. ` +
          `close_code is one of: Solution provided, Workaround provided, Resolved by change, Resolved by caller, Known error, Duplicate, No resolution provided, User error.`,
      );
    }
    if (next.state === 'closed' && rec.state !== 'closed') next.closed_at = at;
    if (resolving) {
      next.resolved_at = at;
      next.resolved_by = actor;
    }
    if (wasResolved && isActiveState(next.state)) {
      // Reopened: clear resolution information.
      next.reopen_count = rec.reopen_count + 1;
      next.resolved_at = null;
      next.resolved_by = null;
      next.closed_at = null;
      next.close_code = null;
      next.close_notes = null;
      // Service is evidently not back; what is known about the outage and its cause stays.
      next.service_restored_at = null;
    }
    if (next.assignment_group !== rec.assignment_group && rec.assignment_group) {
      next.reassignment_count = rec.reassignment_count + 1;
    }

    const changes = this.diff(rec, next);
    const addedLinks: LinkRecord[] = [];
    for (const link of input.add_links ?? []) {
      if (next.links.some((l) => l.url === link.url) || addedLinks.some((l) => l.url === link.url))
        continue;
      addedLinks.push({
        id: this.ids.link(),
        type: link.type,
        url: link.url,
        title: link.title,
        added_by: actor,
        added_at: at,
      });
      changes.push({ field: 'links', label: FIELD_LABELS.links!, from: null, to: link.title });
    }
    next.links = [...rec.links, ...addedLinks];
    next.journal = [...rec.journal];
    if (changes.length > 0) {
      next.journal.push({
        id: this.ids.journal(),
        type: 'system',
        text: describeChanges(changes),
        author: actor,
        created_at: at,
        changes,
      });
    }
    if (input.work_note?.trim())
      next.journal.push(this.entry('work_note', input.work_note, actor, at));
    if (input.comment?.trim()) next.journal.push(this.entry('comment', input.comment, actor, at));

    if (next.journal.length !== rec.journal.length) {
      next.updated_at = at;
      next.updated_by = actor;
    }
    Object.assign(rec, next);

    if (rec.parent_incident !== oldParent && !options.quietParent) {
      if (oldParent)
        this.noteChildChange(
          oldParent,
          `Child incident removed: ${rec.number}`,
          rec.number,
          null,
          actor,
          at,
        );
      if (rec.parent_incident) {
        this.noteChildChange(
          rec.parent_incident,
          `Child incident added: ${rec.number}`,
          null,
          rec.number,
          actor,
          at,
        );
      }
    }
    if (input.comment?.trim()) this.copyCommentToChildren(rec, input.comment, actor, at);
    this.cascadeToChildren(rec, actor, now);
    return rec;
  }

  /** Valid, upper-cased, de-duplicated TLAs without the incident's own application. */
  private affectedCis(values: string[], own: string | null): string[] {
    const out: string[] = [];
    for (const value of values) {
      const tla = this.dir.requireApp(value, 'affected_cis').tla;
      if (tla !== own && !out.includes(tla)) out.push(tla);
    }
    return out;
  }

  /** A CHG number; checked against the change store when it is wired in. */
  private changeRef(value: string, field: string): string {
    const key = value.trim().toUpperCase();
    const lookup = this.relations.changeNumber;
    if (!lookup) return key;
    const number = lookup(key);
    if (!number) {
      throw badRequest(
        `Unknown ${field} '${value}'. Use a change request number such as CHG0030012 (list_change_requests finds them).`,
      );
    }
    return number;
  }

  /** Points an incident at the problem that investigates it (called by the problem store). */
  setProblem(rec: IncidentRecord, problem: string, text: string, actor: string, at: string) {
    const from = rec.problem;
    rec.problem = problem;
    rec.journal.push({
      id: this.ids.journal(),
      type: 'system',
      text,
      author: actor,
      created_at: at,
      changes: [{ field: 'problem', label: FIELD_LABELS.problem!, from, to: problem }],
    });
    rec.updated_at = at;
    rec.updated_by = actor;
  }

  private noteChildChange(
    parentNumber: string,
    text: string,
    from: string | null,
    to: string | null,
    actor: string,
    at: string,
  ) {
    const parent = this.find(parentNumber);
    if (!parent) return;
    parent.journal.push({
      id: this.ids.journal(),
      type: 'system',
      text,
      author: actor,
      created_at: at,
      changes: [{ field: 'child_incidents', label: FIELD_LABELS.child_incidents!, from, to }],
    });
    parent.updated_at = at;
    parent.updated_by = actor;
  }

  /** Like ServiceNow: caller-visible comments on a parent are copied to its open children. */
  private copyCommentToChildren(parent: IncidentRecord, text: string, actor: string, at: string) {
    for (const child of this.childrenOf(parent.number)) {
      if (!isActiveState(child.state)) continue;
      child.journal.push(
        this.entry(
          'comment',
          `Update from parent incident ${parent.number}:\n${text.trim()}`,
          actor,
          at,
        ),
      );
      child.updated_at = at;
      child.updated_by = actor;
    }
  }

  /** Resolving or closing a parent resolves or closes its children with the same resolution. */
  private cascadeToChildren(parent: IncidentRecord, actor: string, now: Date) {
    if (parent.state !== 'resolved' && parent.state !== 'closed') return;
    const done: string[] = [];
    for (const child of this.childrenOf(parent.number)) {
      const needs =
        isActiveState(child.state) || (parent.state === 'closed' && child.state === 'resolved');
      if (!needs) continue;
      this.update(
        child.number,
        {
          state: parent.state,
          close_code: child.close_code ?? parent.close_code ?? 'Solution provided',
          close_notes:
            child.close_notes ??
            `Resolved with parent incident ${parent.number}. ${parent.close_notes ?? ''}`.trim(),
          updated_by: actor,
        },
        now,
      );
      done.push(child.number);
    }
    if (done.length > 0) {
      const at = now.toISOString();
      parent.journal.push({
        id: this.ids.journal(),
        type: 'system',
        text: `${STATE_LABELS[parent.state]} ${done.length} child incident${done.length === 1 ? '' : 's'}: ${done.join(', ')}`,
        author: actor,
        created_at: at,
      });
    }
  }

  addJournal(key: string, input: JournalInput, now = new Date()): JournalEntry {
    const rec = this.require(key);
    const author = this.dir.requireUser(input.author ?? DEFAULT_ACTOR, 'author').username;
    const at = now.toISOString();
    const entry = this.entry(input.type, input.text, author, at);
    rec.journal.push(entry);
    rec.updated_at = at;
    rec.updated_by = author;
    if (input.type === 'comment') this.copyCommentToChildren(rec, input.text, author, at);
    return this.journalEntry(entry);
  }

  private entry(type: JournalType, text: string, author: string, at: string): JournalRecord {
    return { id: this.ids.journal(), type, text: text.trim(), author, created_at: at };
  }

  private display(field: string, rec: IncidentRecord): string | null {
    switch (field) {
      case 'state':
        return STATE_LABELS[rec.state];
      case 'impact':
        return IMPACT_LABELS[rec.impact];
      case 'urgency':
        return IMPACT_LABELS[rec.urgency];
      case 'priority':
        return PRIORITY_LABELS[priorityFor(rec.impact, rec.urgency)];
      case 'assignment_group':
        return rec.assignment_group ? this.dir.groupRef(rec.assignment_group).name : null;
      case 'assigned_to':
        return rec.assigned_to ? this.dir.userRef(rec.assigned_to).name : null;
      case 'caller':
        return rec.caller ? this.dir.userRef(rec.caller).name : null;
      case 'app_tla':
        return rec.app_tla ? this.dir.appDisplay(rec.app_tla) : null;
      case 'contact_type':
        return CONTACT_TYPE_LABELS[rec.contact_type] ?? rec.contact_type;
      case 'affected_cis':
        return rec.affected_cis.join(', ') || null;
      default: {
        const v = rec[field as keyof IncidentRecord];
        return v === null || v === undefined || v === '' ? null : String(v);
      }
    }
  }

  private diff(before: IncidentRecord, after: IncidentRecord): FieldChange[] {
    const fields = [
      'state',
      'priority',
      'impact',
      'urgency',
      'assignment_group',
      'assigned_to',
      'app_tla',
      'short_description',
      'description',
      'category',
      'subcategory',
      'caller',
      'contact_type',
      'close_code',
      'close_notes',
      'parent_incident',
      'affected_cis',
      'outage_start',
      'service_restored_at',
      'cause_code',
      'caused_by_change',
      'resolved_by_change',
    ];
    const changes: FieldChange[] = [];
    for (const field of fields) {
      const from = this.display(field, before);
      const to = this.display(field, after);
      if (from === to) continue;
      changes.push({
        field,
        label: FIELD_LABELS[field]!,
        from: field === 'description' ? null : from,
        to: field === 'description' ? null : to,
      });
    }
    for (const field of LONG_TEXT_FIELDS) {
      const to = after[field];
      if (before[field] === to) continue;
      changes.push({ field, label: FIELD_LABELS[field]!, from: null, to: to ? clip(to) : null });
    }
    return changes;
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  summary(r: IncidentRecord): IncidentSummary {
    const d = this.dir;
    return {
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      state: r.state,
      priority: priorityFor(r.impact, r.urgency),
      impact: r.impact,
      urgency: r.urgency,
      category: r.category,
      app: r.app_tla ? d.appRef(r.app_tla) : null,
      assignment_group: r.assignment_group ? d.groupRef(r.assignment_group) : null,
      assigned_to: r.assigned_to ? d.userRef(r.assigned_to) : null,
      caller: r.caller ? d.userRef(r.caller) : null,
      contact_type: r.contact_type,
      opened_at: r.opened_at,
      updated_at: r.updated_at,
      resolved_at: r.resolved_at,
      parent_incident: r.parent_incident,
      child_count: this.records.reduce((n, x) => n + (x.parent_incident === r.number ? 1 : 0), 0),
      web_url: serviceNowWebUrl.incident(r.number),
    };
  }

  full(r: IncidentRecord): Incident {
    const d = this.dir;
    return {
      ...this.summary(r),
      description: r.description,
      subcategory: r.subcategory,
      opened_by: d.userRef(r.opened_by),
      updated_by: d.userRef(r.updated_by),
      resolved_by: r.resolved_by ? d.userRef(r.resolved_by) : null,
      closed_at: r.closed_at,
      close_code: r.close_code,
      close_notes: r.close_notes,
      affected_cis: r.affected_cis.map((tla) => d.appRef(tla)),
      outage_start: r.outage_start,
      service_restored_at: r.service_restored_at,
      outage_duration_minutes:
        r.outage_start && r.service_restored_at
          ? minutesBetween(r.outage_start, r.service_restored_at)
          : null,
      cause_code: r.cause_code,
      caused_by_change: r.caused_by_change,
      resolved_by_change: r.resolved_by_change,
      root_cause: r.root_cause,
      client_impact: r.client_impact,
      employee_impact: r.employee_impact,
      problem: r.problem,
      communications: this.relations.communications?.(r.number) ?? [],
      reassignment_count: r.reassignment_count,
      reopen_count: r.reopen_count,
      links: r.links.map((l) => ({
        id: l.id,
        type: l.type,
        url: l.url,
        title: l.title,
        added_by: d.userRef(l.added_by),
        added_at: l.added_at,
      })),
      child_incidents: this.childrenOf(r.number).map((c) => this.summary(c)),
      journal: r.journal.map((j) => this.journalEntry(j)),
    };
  }

  journalEntry(j: JournalRecord): JournalEntry {
    return {
      id: j.id,
      type: j.type,
      text: j.text,
      author: this.dir.userRef(j.author),
      created_at: j.created_at,
      ...(j.changes ? { changes: j.changes } : {}),
    };
  }
}

export function sortRecords(records: IncidentRecord[], sort: IncidentSort): IncidentRecord[] {
  const desc = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  const dir = desc ? -1 : 1;
  const cmp = (a: IncidentRecord, b: IncidentRecord): number => {
    switch (key) {
      case 'priority':
        return (
          dir * (priorityFor(a.impact, a.urgency) - priorityFor(b.impact, b.urgency)) ||
          b.opened_at.localeCompare(a.opened_at)
        );
      case 'updated_at':
        return (
          dir * a.updated_at.localeCompare(b.updated_at) || dir * a.number.localeCompare(b.number)
        );
      case 'number':
        return dir * a.number.localeCompare(b.number);
      default:
        return (
          dir * a.opened_at.localeCompare(b.opened_at) || dir * a.number.localeCompare(b.number)
        );
    }
  };
  return [...records].sort(cmp);
}
