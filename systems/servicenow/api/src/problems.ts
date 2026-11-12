import { badRequest, conflict, notFound, parseTime } from '@sim/api-kit';
import {
  ACTIVE_PROBLEM_STATES,
  type CauseCode,
  type FieldChange,
  type IncidentSummary,
  type JournalEntry,
  type JournalType,
  PRIORITY_LABELS,
  PROBLEM_STATE_LABELS,
  type Priority,
  type Problem,
  type ProblemCreateInput,
  type ProblemStandup,
  type ProblemState,
  type ProblemSummary,
  type ProblemUpdateInput,
  priorityFor,
  problemNumber,
  STANDUP,
  serviceNowWebUrl,
} from '@sim/contracts/servicenow';
import { PAST_MAJOR_INCIDENTS, PERSONAS, SHARED_GROUP_IDS, sysId } from '@sim/world';
import type { ChangeStore } from './changes';
import { type Directory, matchesQuery } from './directory';
import type { IncidentStore } from './incidents';
import { clip, DEFAULT_ACTOR, type IncidentRecord, type JournalRecord } from './model';

export const FIRST_PROBLEM_NUMBER = 40001;

// ---------------------------------------------------------------------------
// The daily problem stand-up (8:00 AM Eastern)
// ---------------------------------------------------------------------------

let zoneFormat: Intl.DateTimeFormat | undefined;

/** Wall-clock parts of an instant in the stand-up's time zone. */
function zoneParts(at: Date) {
  zoneFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: STANDUP.time_zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = zoneFormat.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

/** YYYY-MM-DD for calendar parts (day overflow rolls into the next month). */
const ymd = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

/** Today's date (YYYY-MM-DD) in the stand-up's time zone. */
export function standupToday(now = new Date()): string {
  const p = zoneParts(now);
  return ymd(p.year, p.month, p.day);
}

/** Date (YYYY-MM-DD, Eastern) of the next 8:00 AM stand-up strictly after `now`. */
export function nextStandupDate(now = new Date()): string {
  const p = zoneParts(now);
  return ymd(p.year, p.month, p.hour < STANDUP.hour ? p.day : p.day + 1);
}

/** ISO time of the stand-up on a YYYY-MM-DD date (8:00 AM Eastern, DST aware). */
export function standupStartsAt(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, STANDUP.hour);
  let at = wall;
  // Shift by the zone offset; the second pass settles days where the offset changes.
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(at));
    at += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(at).toISOString();
}

/** `next`, `today` or a YYYY-MM-DD date → the stand-up date it means. */
export function resolveStandupDate(value: string, now = new Date()): string {
  const v = value.trim().toLowerCase();
  if (v === 'next') return nextStandupDate(now);
  if (v === 'today') return standupToday(now);
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m && ymd(Number(m[1]), Number(m[2]), Number(m[3])) === v) return v;
  throw badRequest(
    `Invalid stand-up date '${value}' (use "next", "today" or a date like 2026-11-13)`,
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Internal problem row: references are stored as keys (username, group id, TLA, numbers). */
export interface ProblemRecord {
  sys_id: string;
  number: string;
  short_description: string;
  description: string;
  state: ProblemState;
  priority: Priority;
  app_tla: string | null;
  cause_code: CauseCode;
  chronic: boolean;
  proactive: boolean;
  assignment_group: string | null;
  assigned_to: string | null;
  problem_coordinator: string | null;
  /** Incident numbers, in the order they were linked. */
  incidents: string[];
  standup_date: string | null;
  root_cause: string | null;
  workaround: string | null;
  mitigation_plan: string | null;
  action_items: string | null;
  change_request: string | null;
  caused_by_change: string | null;
  vendor: string | null;
  client_impact: string | null;
  employee_impact: string | null;
  opened_by: string;
  updated_by: string;
  opened_at: string;
  updated_at: string;
  journal: JournalRecord[];
}

export interface ProblemFilter {
  state?: ProblemState[];
  active?: boolean;
  app_tla?: string;
  incident?: string;
  standup?: string;
  q?: string;
  opened_after?: string;
}

const FIELD_LABELS: Record<string, string> = {
  state: 'State',
  short_description: 'Short description',
  description: 'Description',
  priority: 'Priority',
  app_tla: 'Configuration item',
  cause_code: 'Cause code',
  root_cause: 'Root cause',
  workaround: 'Workaround',
  mitigation_plan: 'Mitigation/Repair plan',
  action_items: 'Action items',
  change_request: 'Change request',
  caused_by_change: 'Caused by change',
  vendor: 'Vendor',
  client_impact: 'Impact to clients',
  employee_impact: 'Impact to employees',
  chronic: 'Chronic',
  proactive: 'Proactive',
  assignment_group: 'Assignment group',
  assigned_to: 'Assigned to',
  problem_coordinator: 'Problem coordinator',
  incidents: 'Incidents',
  standup_date: 'Stand-up',
};

/** Paragraph fields: the journal records a one-line preview, not the whole text. */
const LONG_TEXT_FIELDS = [
  'root_cause',
  'workaround',
  'mitigation_plan',
  'action_items',
  'client_impact',
  'employee_impact',
] as const;

const isActive = (state: ProblemState) => ACTIVE_PROBLEM_STATES.includes(state);
const yesNo = (v: boolean) => (v ? 'Yes' : 'No');
const sentence = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

function describe(changes: FieldChange[]): string {
  return changes
    .map((c) => {
      if (c.field === 'description') return 'Description updated';
      if (c.field === 'incidents') return `Incidents added: ${c.to}`;
      if ((LONG_TEXT_FIELDS as readonly string[]).includes(c.field))
        return c.to === null ? `${c.label} cleared` : `${c.label} set: ${c.to}`;
      if (c.field === 'standup_date') {
        return c.to === null
          ? `Taken off the ${STANDUP.label} problem stand-up agenda`
          : `On the agenda of the ${STANDUP.label} problem stand-up on ${c.to}`;
      }
      return `${c.label} changed from ${c.from ?? '(empty)'} to ${c.to ?? '(empty)'}`;
    })
    .join('\n');
}

export class ProblemStore {
  records: ProblemRecord[] = [];
  private byKey = new Map<string, ProblemRecord>();
  private nextNumber = FIRST_PROBLEM_NUMBER;
  private journalSeq = 0;

  constructor(
    private readonly dir: Directory,
    private readonly incidents: IncidentStore,
    private readonly changes: ChangeStore,
  ) {
    this.reset();
  }

  /** Restores the seeded baseline. Call after the incident store's reset (it links incidents). */
  reset(now = new Date()) {
    this.records = [];
    this.byKey.clear();
    this.nextNumber = FIRST_PROBLEM_NUMBER;
    this.journalSeq = 0;
    this.seed(now);
  }

  find(key: string): ProblemRecord | undefined {
    const k = key.trim();
    return this.byKey.get(k.toUpperCase()) ?? this.byKey.get(k.toLowerCase());
  }

  require(key: string): ProblemRecord {
    const rec = this.find(key);
    if (!rec) throw notFound(`Problem ${key} not found (use a PRB number like PRB0040001)`);
    return rec;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Newest first. */
  list(filter: ProblemFilter, now = new Date()): ProblemRecord[] {
    const tla = filter.app_tla ? this.dir.requireApp(filter.app_tla).tla : undefined;
    const incident = filter.incident ? this.incidents.require(filter.incident).number : undefined;
    const standup = filter.standup ? resolveStandupDate(filter.standup, now) : undefined;
    const after = parseTime(filter.opened_after, now)?.toISOString();
    return this.records
      .filter((r) => {
        if (filter.state?.length && !filter.state.includes(r.state)) return false;
        if (filter.active !== undefined && isActive(r.state) !== filter.active) return false;
        if (tla && r.app_tla !== tla) return false;
        if (incident && !r.incidents.includes(incident)) return false;
        if (standup && r.standup_date !== standup) return false;
        if (after && r.opened_at < after) return false;
        return matchesQuery(filter.q, [
          r.number,
          r.short_description,
          r.description,
          r.app_tla,
          r.root_cause,
          ...r.incidents,
        ]);
      })
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at) || b.number.localeCompare(a.number));
  }

  /** The agenda of one stand-up: highest priority first, then oldest. */
  standup(date: string, now = new Date()): ProblemStandup {
    const day = resolveStandupDate(date, now);
    const problems = this.records
      .filter((r) => r.standup_date === day)
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.opened_at.localeCompare(b.opened_at) ||
          a.number.localeCompare(b.number),
      );
    return {
      date: day,
      starts_at: standupStartsAt(day),
      problems: problems.map((r) => this.full(r)),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  create(input: ProblemCreateInput, now = new Date()): ProblemRecord {
    // Resolve every reference before creating anything, so a bad value leaves nothing behind.
    const opener = this.dir.requireUser(input.opened_by ?? DEFAULT_ACTOR, 'opened_by').username;
    const incidents = this.freeIncidents(input.incidents ?? []);
    const appTla = input.app_tla
      ? this.dir.requireApp(input.app_tla).tla
      : (incidents.find((i) => i.app_tla)?.app_tla ?? null);
    const group = input.assignment_group
      ? this.dir.requireGroup(input.assignment_group, 'assignment_group').id
      : ((appTla && this.dir.world.appsByTla.get(appTla)?.supportGroupId) ?? null);
    const assignee = input.assigned_to
      ? this.dir.requireUser(input.assigned_to, 'assigned_to').username
      : null;
    const coordinator = input.problem_coordinator
      ? this.dir.requireUser(input.problem_coordinator, 'problem_coordinator').username
      : this.defaultCoordinator();
    const changeRequest = input.change_request
      ? this.changeRef(input.change_request, 'change_request')
      : null;
    const causedBy = input.caused_by_change
      ? this.changeRef(input.caused_by_change, 'caused_by_change')
      : null;
    const at = now.toISOString();
    const number = problemNumber(this.nextNumber++);
    const text = (v: string | undefined) => v?.trim() || null;
    const rec: ProblemRecord = {
      sys_id: sysId(`problem:${number}`),
      number,
      short_description: input.short_description.trim(),
      description: input.description?.trim() ?? '',
      state: 'open',
      priority: input.priority ?? this.incidentPriority(incidents) ?? 3,
      app_tla: appTla,
      cause_code: input.cause_code ?? 'Under investigation',
      chronic: input.chronic ?? false,
      proactive: input.proactive ?? false,
      assignment_group: group,
      assigned_to: assignee,
      problem_coordinator: coordinator,
      incidents: incidents.map((i) => i.number),
      standup_date: input.standup === false ? null : nextStandupDate(now),
      root_cause: text(input.root_cause),
      workaround: text(input.workaround),
      mitigation_plan: text(input.mitigation_plan),
      action_items: text(input.action_items),
      change_request: changeRequest,
      caused_by_change: causedBy,
      vendor: text(input.vendor),
      client_impact: text(input.client_impact),
      employee_impact: text(input.employee_impact),
      opened_by: opener,
      updated_by: opener,
      opened_at: at,
      updated_at: at,
      journal: [],
    };
    rec.journal.push(
      this.entry('system', this.openedText(rec), opener, at, this.initialValues(rec)),
    );
    this.add(rec);
    for (const inc of incidents) {
      this.incidents.setProblem(
        inc,
        number,
        `Problem ${number} opened to investigate this incident`,
        opener,
        at,
      );
    }
    return rec;
  }

  update(key: string, input: ProblemUpdateInput, now = new Date()): ProblemRecord {
    const rec = this.require(key);
    const actor = this.dir.requireUser(input.updated_by ?? DEFAULT_ACTOR, 'updated_by').username;
    const at = now.toISOString();

    // Resolve every reference first: a bad value must not leave a half-applied update.
    const next: ProblemRecord = { ...rec };
    if (input.state !== undefined) next.state = input.state;
    if (input.short_description !== undefined)
      next.short_description = input.short_description.trim();
    if (input.description !== undefined) next.description = input.description.trim();
    if (input.priority !== undefined) next.priority = input.priority;
    if (input.cause_code !== undefined) next.cause_code = input.cause_code;
    for (const field of LONG_TEXT_FIELDS) {
      const value = input[field];
      if (value !== undefined) next[field] = value?.trim() || null;
    }
    if (input.vendor !== undefined) next.vendor = input.vendor?.trim() || null;
    if (input.change_request !== undefined) {
      next.change_request = input.change_request
        ? this.changeRef(input.change_request, 'change_request')
        : null;
    }
    if (input.caused_by_change !== undefined) {
      next.caused_by_change = input.caused_by_change
        ? this.changeRef(input.caused_by_change, 'caused_by_change')
        : null;
    }
    if (input.chronic !== undefined) next.chronic = input.chronic;
    if (input.proactive !== undefined) next.proactive = input.proactive;
    if (input.assignment_group !== undefined) {
      next.assignment_group = input.assignment_group
        ? this.dir.requireGroup(input.assignment_group, 'assignment_group').id
        : null;
    }
    if (input.assigned_to !== undefined) {
      next.assigned_to = input.assigned_to
        ? this.dir.requireUser(input.assigned_to, 'assigned_to').username
        : null;
    }
    if (input.problem_coordinator !== undefined) {
      next.problem_coordinator = input.problem_coordinator
        ? this.dir.requireUser(input.problem_coordinator, 'problem_coordinator').username
        : null;
    }
    if (input.standup !== undefined)
      next.standup_date = input.standup ? nextStandupDate(now) : null;
    const added = this.freeIncidents(input.add_incidents ?? [], rec.number).filter(
      (i) => !rec.incidents.includes(i.number),
    );
    if (added.length > 0) next.incidents = [...rec.incidents, ...added.map((i) => i.number)];

    const changes = this.diff(rec, next);
    if (added.length > 0) {
      changes.push({
        field: 'incidents',
        label: FIELD_LABELS.incidents!,
        from: null,
        to: added.map((i) => i.number).join(', '),
      });
    }
    next.journal = [...rec.journal];
    if (changes.length > 0) {
      next.journal.push(this.entry('system', describe(changes), actor, at, changes));
    }
    if (input.work_note?.trim())
      next.journal.push(this.entry('work_note', input.work_note, actor, at));
    if (next.journal.length !== rec.journal.length) {
      next.updated_at = at;
      next.updated_by = actor;
    }
    Object.assign(rec, next);
    for (const inc of added) {
      this.incidents.setProblem(
        inc,
        rec.number,
        `Problem ${rec.number} now investigates this incident`,
        actor,
        at,
      );
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private add(rec: ProblemRecord) {
    this.records.push(rec);
    this.byKey.set(rec.number, rec);
    this.byKey.set(rec.sys_id, rec);
  }

  /**
   * The incidents behind these numbers, de-duplicated. An incident has one problem: one that is
   * already investigated by another problem (not `own`) is a conflict.
   */
  private freeIncidents(keys: string[], own?: string): IncidentRecord[] {
    const incidents = [...new Set(keys.map((k) => this.incidents.require(k)))];
    for (const inc of incidents) {
      if (inc.problem && inc.problem !== own) {
        throw conflict(
          `${inc.number} is already investigated by problem ${inc.problem}. Update ${inc.problem} instead of opening another problem for it.`,
        );
      }
    }
    return incidents;
  }

  private changeRef(value: string, field: string): string {
    const change = this.changes.find(value);
    if (!change) {
      throw badRequest(
        `Unknown ${field} '${value}'. Use a change request number such as CHG0030012 (list_change_requests finds them).`,
      );
    }
    return change.number;
  }

  /** Primary on-call of Major Incident Management. */
  private defaultCoordinator(): string | null {
    return this.dir.world.groupsById.get(SHARED_GROUP_IDS.majorIncident)?.onCall.primary ?? null;
  }

  private linked(rec: ProblemRecord): IncidentRecord[] {
    return rec.incidents
      .map((n) => this.incidents.find(n))
      .filter((i): i is IncidentRecord => i !== undefined);
  }

  /** Highest priority (lowest number) among incidents, null when there are none. */
  private incidentPriority(incidents: IncidentRecord[]): Priority | null {
    if (incidents.length === 0) return null;
    return Math.min(...incidents.map((i) => priorityFor(i.impact, i.urgency))) as Priority;
  }

  private openedText(rec: ProblemRecord): string {
    return [
      rec.incidents.length > 0
        ? `Problem opened to investigate ${rec.incidents.join(', ')}`
        : 'Problem opened',
      ...(rec.standup_date
        ? [`On the agenda of the ${STANDUP.label} problem stand-up on ${rec.standup_date}`]
        : []),
    ].join('\n');
  }

  private display(field: string, rec: ProblemRecord): string | null {
    switch (field) {
      case 'state':
        return PROBLEM_STATE_LABELS[rec.state];
      case 'priority':
        return PRIORITY_LABELS[rec.priority];
      case 'app_tla':
        return rec.app_tla ? this.dir.appDisplay(rec.app_tla) : null;
      case 'assignment_group':
        return rec.assignment_group ? this.dir.groupRef(rec.assignment_group).name : null;
      case 'assigned_to':
        return rec.assigned_to ? this.dir.userRef(rec.assigned_to).name : null;
      case 'problem_coordinator':
        return rec.problem_coordinator ? this.dir.userRef(rec.problem_coordinator).name : null;
      case 'chronic':
        return yesNo(rec.chronic);
      case 'proactive':
        return yesNo(rec.proactive);
      default: {
        const v = rec[field as keyof ProblemRecord];
        return v === null || v === undefined || v === '' ? null : String(v);
      }
    }
  }

  /** Field values shown on the "Problem opened" entry. */
  private initialValues(rec: ProblemRecord): FieldChange[] {
    return [
      'state',
      'priority',
      'app_tla',
      'cause_code',
      'assignment_group',
      'assigned_to',
      'problem_coordinator',
      'standup_date',
    ]
      .map((field) => ({
        field,
        label: FIELD_LABELS[field]!,
        from: null,
        to: this.display(field, rec),
      }))
      .filter((c) => c.to !== null);
  }

  private diff(before: ProblemRecord, after: ProblemRecord): FieldChange[] {
    const fields = [
      'state',
      'priority',
      'short_description',
      'description',
      'cause_code',
      'change_request',
      'caused_by_change',
      'vendor',
      'chronic',
      'proactive',
      'assignment_group',
      'assigned_to',
      'problem_coordinator',
      'standup_date',
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

  private entry(
    type: JournalType,
    text: string,
    author: string,
    at: string,
    changes?: FieldChange[],
  ): JournalRecord {
    return {
      // Problems are not on the activity feed, so they keep their own journal sequence.
      id: `pjn_${String(++this.journalSeq).padStart(6, '0')}`,
      type,
      text: text.trim(),
      author,
      created_at: at,
      ...(changes?.length ? { changes } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Seed
  // -------------------------------------------------------------------------

  /**
   * History: a reviewed problem for each past major incident that was a P1 or P2. Built from
   * the same `PAST_MAJOR_INCIDENTS` as the incidents, with timestamps relative to `now`.
   */
  private seed(now: Date) {
    const coordinator = this.defaultCoordinator();
    const mim = PERSONAS.majorIncidentManager;
    for (const past of PAST_MAJOR_INCIDENTS) {
      if (past.priority === 'P3') continue;
      const inc = this.incidents.find(past.number);
      const app = this.dir.world.appsByTla.get(past.tla);
      if (!inc?.resolved_at || !app) continue;
      const group = this.dir.world.groupsById.get(app.supportGroupId);
      const openedMs = Date.parse(inc.resolved_at) + 4 * 60_000;
      const opened = new Date(openedMs).toISOString();
      const standupDate = nextStandupDate(new Date(openedMs));
      const reviewedMs = Date.parse(standupStartsAt(standupDate)) + 20 * 60_000;
      const reviewed = reviewedMs < now.getTime();
      const state: ProblemState = !reviewed
        ? 'open'
        : inc.state === 'closed'
          ? 'closed'
          : 'resolved';
      const number = problemNumber(this.nextNumber++);
      const rec: ProblemRecord = {
        sys_id: sysId(`problem:${number}`),
        number,
        short_description: past.shortDescription,
        description: `Post-incident review of ${past.number}. ${past.summary}`,
        state: 'open',
        priority: priorityFor(inc.impact, inc.urgency),
        app_tla: app.tla,
        cause_code: past.closeCode === 'Resolved by change' ? 'Change' : 'Configuration',
        chronic: false,
        proactive: false,
        assignment_group: app.supportGroupId,
        assigned_to: group?.onCall.primary ?? null,
        problem_coordinator: coordinator,
        incidents: [inc.number],
        standup_date: standupDate,
        root_cause: sentence(past.cause),
        workaround: null,
        mitigation_plan: sentence(past.fix),
        action_items: null,
        change_request: null,
        caused_by_change: null,
        vendor: null,
        client_impact: past.summary,
        employee_impact: null,
        opened_by: mim,
        updated_by: mim,
        opened_at: opened,
        updated_at: opened,
        journal: [],
      };
      rec.journal.push(
        this.entry('system', this.openedText(rec), mim, opened, this.initialValues(rec)),
      );
      if (reviewed) {
        const at = new Date(reviewedMs).toISOString();
        rec.journal.push(
          this.entry(
            'work_note',
            `Reviewed at the ${STANDUP.label} problem stand-up on ${standupDate} with ${group?.name ?? app.tla}. Root cause confirmed; no further actions.`,
            mim,
            at,
          ),
        );
        rec.state = state;
        rec.journal.push(
          this.entry(
            'system',
            `State changed from ${PROBLEM_STATE_LABELS.open} to ${PROBLEM_STATE_LABELS[state]}`,
            mim,
            at,
            [
              {
                field: 'state',
                label: FIELD_LABELS.state!,
                from: PROBLEM_STATE_LABELS.open,
                to: PROBLEM_STATE_LABELS[state],
              },
            ],
          ),
        );
        rec.updated_at = at;
      }
      this.add(rec);
      // History: linked without a new journal entry, so the incident's activity stays as seeded.
      inc.problem = number;
    }
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  summary(r: ProblemRecord): ProblemSummary {
    const d = this.dir;
    return {
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      state: r.state,
      priority: r.priority,
      incident_priority: this.incidentPriority(this.linked(r)),
      app: r.app_tla ? d.appRef(r.app_tla) : null,
      cause_code: r.cause_code,
      chronic: r.chronic,
      proactive: r.proactive,
      assignment_group: r.assignment_group ? d.groupRef(r.assignment_group) : null,
      assigned_to: r.assigned_to ? d.userRef(r.assigned_to) : null,
      problem_coordinator: r.problem_coordinator ? d.userRef(r.problem_coordinator) : null,
      incidents: [...r.incidents],
      standup_date: r.standup_date,
      opened_at: r.opened_at,
      updated_at: r.updated_at,
      web_url: serviceNowWebUrl.problem(r.number),
    };
  }

  full(r: ProblemRecord): Problem {
    const d = this.dir;
    const related: IncidentSummary[] = this.linked(r)
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.number.localeCompare(b.number))
      .map((i) => this.incidents.summary(i));
    return {
      ...this.summary(r),
      description: r.description,
      root_cause: r.root_cause,
      workaround: r.workaround,
      mitigation_plan: r.mitigation_plan,
      action_items: r.action_items,
      change_request: r.change_request,
      caused_by_change: r.caused_by_change,
      vendor: r.vendor,
      client_impact: r.client_impact,
      employee_impact: r.employee_impact,
      opened_by: d.userRef(r.opened_by),
      updated_by: d.userRef(r.updated_by),
      related_incidents: related,
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
