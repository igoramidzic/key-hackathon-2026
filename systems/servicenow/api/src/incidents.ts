import { badRequest, conflict, notFound, parseTime } from '@sim/api-kit';
import {
  CONTACT_TYPE_LABELS,
  type FieldChange,
  IMPACT_LABELS,
  type Incident,
  type IncidentCreateInput,
  type IncidentSort,
  type IncidentState,
  type IncidentSummary,
  type IncidentUpdateInput,
  isActiveState,
  type JournalEntry,
  type JournalInput,
  type JournalType,
  PRIORITY_LABELS,
  priorityFor,
  STATE_LABELS,
  serviceNowWebUrl,
} from '@sim/contracts/servicenow';
import { sysId } from '@sim/world';
import { type Directory, matchesQuery } from './directory';
import {
  DEFAULT_ACTOR,
  FIRST_NUMBER,
  type IdGen,
  type IncidentRecord,
  incidentNumber,
  type JournalRecord,
  type LinkRecord,
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
  q?: string;
  opened_after?: string;
  sort?: IncidentSort;
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
  links: 'Related link',
};

/** "State changed from New to In Progress" lines for a system journal entry. */
export function describeChanges(changes: FieldChange[]): string {
  return changes
    .map((c) => {
      if (c.field === 'links') return `Related link added: ${c.to}`;
      if (c.field === 'description') return 'Description updated';
      if (c.field === 'close_notes') return `Resolution notes set: ${c.to ?? '(empty)'}`;
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
  readonly ids: IdGen = {
    journal: () => `jrn_${String(++this.journalSeq).padStart(6, '0')}`,
    link: () => `lnk_${String(++this.linkSeq).padStart(5, '0')}`,
  };

  constructor(private readonly dir: Directory) {
    this.reset();
  }

  /** Restores the seeded baseline (timestamps relative to now). */
  reset(now = new Date()) {
    this.journalSeq = 0;
    this.linkSeq = 0;
    this.records = seedIncidents(this.dir, now, this.ids);
    this.byKey.clear();
    for (const rec of this.records) this.index(rec);
    // New incidents continue after the highest seeded number.
    this.nextNumber =
      Math.max(FIRST_NUMBER - 1, ...this.records.map((r) => Number(r.number.slice(3)))) + 1;
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

    const out = this.records.filter((r) => {
      if (states && !states.has(r.state)) return false;
      if (priorities && !priorities.has(priorityFor(r.impact, r.urgency))) return false;
      if (filter.active !== undefined && isActiveState(r.state) !== filter.active) return false;
      if (tla && r.app_tla !== tla) return false;
      if (group && r.assignment_group !== group) return false;
      if (unassigned && r.assigned_to) return false;
      if (assignee && r.assigned_to !== assignee) return false;
      if (caller && r.caller !== caller) return false;
      if (after && r.opened_at < after) return false;
      if (filter.q) {
        const app = r.app_tla ? this.dir.world.appsByTla.get(r.app_tla) : undefined;
        if (
          !matchesQuery(filter.q, [
            r.number,
            r.short_description,
            r.description,
            r.app_tla,
            app?.name,
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

  countOpen(predicate: (r: IncidentRecord) => boolean): number {
    let n = 0;
    for (const r of this.records) if (isActiveState(r.state) && predicate(r)) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  create(input: IncidentCreateInput, now = new Date()): IncidentRecord {
    const openedBy = this.dir.requireUser(input.opened_by ?? DEFAULT_ACTOR, 'opened_by').username;
    const caller = input.caller ? this.dir.requireUser(input.caller, 'caller').username : openedBy;
    const app = input.app_tla ? this.dir.requireApp(input.app_tla).tla : null;
    const group = input.assignment_group
      ? this.dir.requireGroup(input.assignment_group, 'assignment_group').id
      : null;
    const assignee = input.assigned_to
      ? this.dir.requireUser(input.assigned_to, 'assigned_to').username
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
    return rec;
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
    ];
    return fields
      .filter(([, v]) => v !== null)
      .map(([field, to]) => ({ field, label: FIELD_LABELS[field]!, from: null, to }));
  }

  update(key: string, input: IncidentUpdateInput, now = new Date()): IncidentRecord {
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
    return rec;
  }

  addJournal(key: string, input: JournalInput, now = new Date()): JournalEntry {
    const rec = this.require(key);
    const author = this.dir.requireUser(input.author ?? DEFAULT_ACTOR, 'author').username;
    const at = now.toISOString();
    const entry = this.entry(input.type, input.text, author, at);
    rec.journal.push(entry);
    rec.updated_at = at;
    rec.updated_by = author;
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
