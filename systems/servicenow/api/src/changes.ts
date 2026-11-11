import { badRequest, conflict, notFound, parseTime } from '@sim/api-kit';
import { URLS } from '@sim/contracts';
import {
  CHANGE_RISK_LABELS,
  CHANGE_STATE_LABELS,
  CHANGE_TYPE_LABELS,
  type ChangeCloseCode,
  type ChangeCreateInput,
  type ChangeDeployment,
  type ChangeImportInput,
  type ChangeMergeRequest,
  type ChangeMergeRequestInput,
  type ChangeRelease,
  type ChangeReleaseInput,
  type ChangeRequest,
  type ChangeRequestSummary,
  type ChangeRisk,
  type ChangeSort,
  type ChangeState,
  type ChangeType,
  type ChangeUpdateInput,
  changeNumber,
  type FieldChange,
  isActiveChangeState,
  type JournalEntry,
  type JournalInput,
  type JournalType,
  parseMergeRequestRef,
  serviceNowWebUrl,
} from '@sim/contracts/servicenow';
import { groupPathForTla, PERSONAS, sysId } from '@sim/world';
import { type Directory, matchesQuery } from './directory';
import type { IncidentStore } from './incidents';
import { DEFAULT_ACTOR, type JournalRecord } from './model';

export const FIRST_CHANGE_NUMBER = 30001;
export const KBR_USER = PERSONAS.releaseBot;

/** Internal change row: references are stored as keys (username, group id, TLA). */
export interface ChangeRecord {
  sys_id: string;
  number: string;
  short_description: string;
  description: string;
  justification: string;
  backout_plan: string;
  type: ChangeType;
  state: ChangeState;
  risk: ChangeRisk;
  app_tla: string;
  merge_requests: ChangeMergeRequest[];
  deployments: ChangeDeployment[];
  requested_by: string;
  opened_by: string;
  updated_by: string;
  assignment_group: string | null;
  planned_start: string | null;
  implemented_at: string | null;
  close_code: ChangeCloseCode | null;
  close_notes: string | null;
  release: ChangeRelease;
  related_incidents: string[];
  opened_at: string;
  updated_at: string;
  journal: JournalRecord[];
}

export interface ChangeFilter {
  state?: ChangeState[];
  type?: ChangeType[];
  active?: boolean;
  app_tla?: string;
  project?: string;
  merge_request?: string;
  requested_by?: string;
  related_incident?: string;
  q?: string;
  implemented_after?: string;
  implemented_before?: string;
  planned_after?: string;
  planned_before?: string;
  sort?: ChangeSort;
}

const FIELD_LABELS: Record<string, string> = {
  state: 'State',
  planned_start: 'Planned start',
  short_description: 'Short description',
  description: 'Description',
  type: 'Type',
  risk: 'Risk',
  merge_requests: 'Merge requests',
  related_incidents: 'Related incidents',
};

/**
 * When KBR should run: `now`, an ISO time, or a future offset (`+30m`, `in 2h`, `30m`). Bare
 * offsets are read as "from now" (a planned start is always ahead).
 */
export function parsePlannedStart(value: string, now = new Date()): Date {
  const v = value.trim().toLowerCase();
  if (v === 'now' || v === 'asap' || v === 'immediately') return now;
  const rel = v.match(/^(?:\+|in\s+)?(\d+)\s*(s|m|min|h|d)$/);
  if (rel) {
    const unit = rel[2]!.startsWith('m') ? 'm' : rel[2]!;
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 's' | 'm' | 'h' | 'd'];
    return new Date(now.getTime() + Number(rel[1]) * ms);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(
      `Invalid planned_start '${value}' (use an ISO time, "now", or an offset like "+30m")`,
    );
  }
  return date;
}

const mrWebUrl = (project: string, iid: number) =>
  `${URLS.gitlab.web}/${project}/-/merge_requests/${iid}`;

export class ChangeStore {
  records: ChangeRecord[] = [];
  private byKey = new Map<string, ChangeRecord>();
  private nextNumber = FIRST_CHANGE_NUMBER;

  constructor(
    private readonly dir: Directory,
    private readonly incidents: IncidentStore,
  ) {}

  /** Empty: the simulator backfills history from GitLab's merged MRs after every reset. */
  reset() {
    this.records = [];
    this.byKey.clear();
    this.nextNumber = FIRST_CHANGE_NUMBER;
  }

  find(key: string): ChangeRecord | undefined {
    const k = key.trim();
    return this.byKey.get(k.toUpperCase()) ?? this.byKey.get(k.toLowerCase());
  }

  require(key: string): ChangeRecord {
    const rec = this.find(key);
    if (!rec) throw notFound(`Change request ${key} not found (use a CHG number like CHG0030012)`);
    return rec;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(filter: ChangeFilter, now = new Date()): ChangeRecord[] {
    const tla = filter.app_tla ? this.dir.requireApp(filter.app_tla).tla : undefined;
    const requester = filter.requested_by
      ? this.dir.requireUser(filter.requested_by, 'requested_by').username
      : undefined;
    const project = filter.project
      ?.trim()
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    const mrRef = filter.merge_request ? parseMergeRequestRef(filter.merge_request) : undefined;
    if (filter.merge_request && !mrRef) {
      throw badRequest(
        `Invalid merge_request '${filter.merge_request}' (use keybank/PAY00/payments-api!12 or the MR URL)`,
      );
    }
    const incident = filter.related_incident?.trim().toUpperCase();
    const time = (v?: string) => (v ? parseTime(v, now)?.toISOString() : undefined);
    const implAfter = time(filter.implemented_after);
    const implBefore = time(filter.implemented_before);
    const planAfter = time(filter.planned_after);
    const planBefore = time(filter.planned_before);
    const out = this.records.filter((r) => {
      if (filter.state?.length && !filter.state.includes(r.state)) return false;
      if (filter.type?.length && !filter.type.includes(r.type)) return false;
      if (filter.active !== undefined && isActiveChangeState(r.state) !== filter.active)
        return false;
      if (tla && r.app_tla !== tla) return false;
      if (requester && r.requested_by !== requester) return false;
      if (project && !r.merge_requests.some((m) => m.project.toLowerCase() === project))
        return false;
      if (
        mrRef &&
        !r.merge_requests.some(
          (m) => m.project.toLowerCase() === mrRef.project.toLowerCase() && m.iid === mrRef.iid,
        )
      )
        return false;
      if (incident && !r.related_incidents.includes(incident)) return false;
      if (implAfter && !(r.implemented_at && r.implemented_at >= implAfter)) return false;
      if (implBefore && !(r.implemented_at && r.implemented_at <= implBefore)) return false;
      if (planAfter && !(r.planned_start && r.planned_start >= planAfter)) return false;
      if (planBefore && !(r.planned_start && r.planned_start <= planBefore)) return false;
      return matchesQuery(filter.q, [
        r.number,
        r.short_description,
        r.description,
        r.app_tla,
        ...r.merge_requests.flatMap((m) => [m.reference, m.title ?? '']),
      ]);
    });
    return sortChanges(out, filter.sort ?? '-opened_at');
  }

  /** Scheduled changes whose planned start has passed (what KBR runs next). */
  due(now = new Date()): ChangeRecord[] {
    const at = now.toISOString();
    return this.records.filter(
      (r) => r.state === 'scheduled' && r.planned_start !== null && r.planned_start <= at,
    );
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  create(input: ChangeCreateInput, now = new Date()): ChangeRecord {
    const app = this.dir.requireApp(input.app_tla);
    const mrs = this.mergeRequests(input.merge_requests, app.tla);
    if (mrs.length === 0) {
      throw badRequest(
        'A change request needs at least one merge request to promote (e.g. keybank/PAY00/payments-api!12).',
      );
    }
    const opener = this.dir.requireUser(input.requested_by ?? DEFAULT_ACTOR, 'requested_by');
    const group = input.assignment_group
      ? this.dir.requireGroup(input.assignment_group, 'assignment_group').id
      : app.supportGroupId;
    const planned = input.planned_start ? parsePlannedStart(input.planned_start, now) : null;
    const related = this.relatedIncidents(input.related_incidents ?? []);
    const at = now.toISOString();
    const number = changeNumber(this.nextNumber++);
    const type = input.type ?? 'normal';
    const rec: ChangeRecord = {
      sys_id: sysId(`change:${number}`),
      number,
      short_description: input.short_description.trim(),
      description: input.description?.trim() ?? '',
      justification: input.justification?.trim() ?? '',
      backout_plan:
        input.backout_plan?.trim() ||
        'KBR redeploys the previous production revision (rollback release).',
      type,
      state: planned ? 'scheduled' : 'new',
      risk: input.risk ?? (type === 'emergency' ? 'high' : 'moderate'),
      app_tla: app.tla,
      merge_requests: mrs,
      deployments: [],
      requested_by: opener.username,
      opened_by: opener.username,
      updated_by: opener.username,
      assignment_group: group,
      planned_start: planned?.toISOString() ?? null,
      implemented_at: null,
      close_code: null,
      close_notes: null,
      release: { id: null, status: 'waiting', started_at: null, finished_at: null },
      related_incidents: related,
      opened_at: at,
      updated_at: at,
      journal: [],
    };
    rec.journal.push(
      this.entry(
        'system',
        [
          `Change request opened: ${CHANGE_TYPE_LABELS[type]} change for ${this.dir.appDisplay(app.tla)}`,
          `Merge requests: ${mrs.map((m) => m.reference).join(', ')}`,
          planned
            ? `Scheduled: KBR promotes QV to production at ${rec.planned_start}`
            : 'No planned start yet: KBR will not run until it is scheduled',
        ].join('\n'),
        opener.username,
        at,
      ),
    );
    this.add(rec);
    this.noteIncidents(rec, related, `${number} raised: ${rec.short_description}`, at);
    return rec;
  }

  update(key: string, input: ChangeUpdateInput, now = new Date()): ChangeRecord {
    const rec = this.require(key);
    const actor = this.dir.requireUser(input.updated_by ?? DEFAULT_ACTOR, 'updated_by').username;
    const at = now.toISOString();
    const editable = rec.state === 'new' || rec.state === 'scheduled';
    const wantsEdit =
      input.state !== undefined ||
      input.planned_start !== undefined ||
      input.short_description !== undefined ||
      input.description !== undefined ||
      input.type !== undefined ||
      input.risk !== undefined ||
      (input.add_merge_requests?.length ?? 0) > 0;
    if (wantsEdit && !editable) {
      throw conflict(
        `${rec.number} is ${CHANGE_STATE_LABELS[rec.state]} and can no longer be changed (work notes only). Raise a new change request instead.`,
      );
    }
    const changes: FieldChange[] = [];
    const set = <K extends keyof ChangeRecord>(
      field: K,
      value: ChangeRecord[K],
      show: (v: ChangeRecord[K]) => string | null,
    ) => {
      if (rec[field] === value) return;
      changes.push({
        field,
        label: FIELD_LABELS[field] ?? field,
        from: show(rec[field]),
        to: show(value),
      });
      rec[field] = value;
    };
    const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

    if (input.short_description !== undefined)
      set('short_description', input.short_description.trim(), str);
    if (input.description !== undefined) set('description', input.description.trim(), str);
    if (input.type !== undefined) set('type', input.type, (v) => CHANGE_TYPE_LABELS[v]);
    if (input.risk !== undefined) set('risk', input.risk, (v) => CHANGE_RISK_LABELS[v]);
    if (input.add_merge_requests?.length) {
      const added = this.mergeRequests(input.add_merge_requests, rec.app_tla).filter(
        (m) => !rec.merge_requests.some((x) => x.reference === m.reference),
      );
      if (added.length > 0) {
        changes.push({
          field: 'merge_requests',
          label: FIELD_LABELS.merge_requests!,
          from: null,
          to: added.map((m) => m.reference).join(', '),
        });
        rec.merge_requests = [...rec.merge_requests, ...added];
      }
    }
    if (input.related_incidents?.length) {
      const added = this.relatedIncidents(input.related_incidents).filter(
        (n) => !rec.related_incidents.includes(n),
      );
      if (added.length > 0) {
        changes.push({
          field: 'related_incidents',
          label: FIELD_LABELS.related_incidents!,
          from: null,
          to: added.join(', '),
        });
        rec.related_incidents = [...rec.related_incidents, ...added];
        this.noteIncidents(rec, added, `Related to ${rec.number}: ${rec.short_description}`, at);
      }
    }
    if (input.planned_start !== undefined) {
      set('planned_start', parsePlannedStart(input.planned_start, now).toISOString(), str);
      // Giving a draft a date schedules it, unless the caller says otherwise.
      if (rec.state === 'new' && input.state === undefined) set('state', 'scheduled', label);
    }
    if (input.state !== undefined && input.state !== rec.state) {
      if (input.state === 'scheduled' && !rec.planned_start) {
        throw badRequest('Set planned_start to schedule the change (e.g. "now" or "+30m").');
      }
      set('state', input.state, label);
      if (input.state === 'canceled') rec.release = { ...rec.release, status: 'waiting' };
    }
    if (changes.length > 0) {
      rec.journal.push(this.entry('system', describe(changes), actor, at, changes));
    }
    if (input.work_note?.trim())
      rec.journal.push(this.entry('work_note', input.work_note, actor, at));
    if (changes.length > 0 || input.work_note?.trim()) {
      rec.updated_at = at;
      rec.updated_by = actor;
    }
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

  /** KBR reports progress: running → succeeded | failed. */
  recordRelease(key: string, input: ChangeReleaseInput, now = new Date()): ChangeRecord {
    const rec = this.require(key);
    const at = now.toISOString();
    if (input.merge_requests?.length) rec.merge_requests = input.merge_requests;
    if (input.status === 'running') {
      if (rec.state !== 'scheduled') {
        throw conflict(
          `${rec.number} is ${CHANGE_STATE_LABELS[rec.state]}; KBR only starts scheduled changes`,
        );
      }
      rec.state = 'implement';
      rec.release = {
        id: input.release_id ?? rec.release.id,
        status: 'running',
        started_at: at,
        finished_at: null,
      };
      rec.journal.push(
        this.entry(
          'system',
          input.note ??
            `State changed from Scheduled to Implement\nKBR release ${rec.release.id ?? ''} started: promoting QV to production`,
          KBR_USER,
          at,
          [{ field: 'state', label: 'State', from: 'Scheduled', to: 'Implement' }],
        ),
      );
    } else if (input.status === 'succeeded') {
      if (rec.state !== 'implement') {
        throw conflict(`${rec.number} is ${CHANGE_STATE_LABELS[rec.state]}, not Implement`);
      }
      rec.state = 'closed';
      rec.close_code = 'successful';
      rec.implemented_at = at;
      rec.deployments = input.deployments ?? rec.deployments;
      rec.release = { ...rec.release, status: 'succeeded', finished_at: at };
      rec.close_notes =
        input.note ??
        `Implemented by KBR release ${rec.release.id}. Promoted ${rec.deployments.length} project(s) from QV to production.`;
      rec.journal.push(this.entry('work_note', deploymentNote(rec, input.note), KBR_USER, at));
      rec.journal.push(
        this.entry(
          'system',
          'State changed from Implement to Closed\nClose code: Successful',
          KBR_USER,
          at,
          [{ field: 'state', label: 'State', from: 'Implement', to: 'Closed' }],
        ),
      );
      this.noteIncidents(
        rec,
        rec.related_incidents,
        `${rec.number} implemented by KBR release ${rec.release.id}: ${rec.deployments
          .map((d) => `${d.service ?? d.project} ${d.version ?? d.short_sha}`)
          .join(', ')} now in production.`,
        at,
        KBR_USER,
      );
    } else {
      if (rec.state !== 'implement' && rec.state !== 'scheduled') {
        throw conflict(`${rec.number} is ${CHANGE_STATE_LABELS[rec.state]}; nothing to fail`);
      }
      const from = CHANGE_STATE_LABELS[rec.state];
      rec.state = 'new';
      rec.release = { ...rec.release, status: 'failed', finished_at: at };
      rec.journal.push(
        this.entry(
          'work_note',
          `KBR release ${rec.release.id ?? ''} aborted. Nothing was promoted.\n\n${input.note ?? ''}`.trim(),
          KBR_USER,
          at,
        ),
      );
      rec.journal.push(
        this.entry(
          'system',
          `State changed from ${from} to New\nFix the problem, then set a new planned start to reschedule.`,
          KBR_USER,
          at,
          [{ field: 'state', label: 'State', from, to: 'New' }],
        ),
      );
    }
    rec.updated_at = at;
    rec.updated_by = KBR_USER;
    return rec;
  }

  /** Simulator import: history (closed by KBR) and scenario changes (already scheduled). */
  import(input: ChangeImportInput, now = new Date()): ChangeRecord {
    const app = this.dir.requireApp(input.app_tla);
    const requester = this.dir.requireUser(input.requested_by, 'requested_by').username;
    const number = changeNumber(this.nextNumber++);
    const opened = new Date(input.opened_at).toISOString();
    const planned = new Date(input.planned_start).toISOString();
    const type = input.type ?? 'normal';
    const closed = input.state === 'closed';
    const rec: ChangeRecord = {
      sys_id: sysId(`change:${number}`),
      number,
      short_description: input.short_description.trim(),
      description: input.description?.trim() ?? '',
      justification: '',
      backout_plan: 'KBR redeploys the previous production revision (rollback release).',
      type,
      state: input.state,
      risk: input.risk ?? 'low',
      app_tla: app.tla,
      merge_requests: input.merge_requests,
      deployments: closed ? (input.deployments ?? []) : [],
      requested_by: requester,
      opened_by: requester,
      updated_by: closed ? KBR_USER : requester,
      assignment_group: app.supportGroupId,
      planned_start: planned,
      implemented_at: closed ? planned : null,
      close_code: closed ? 'successful' : null,
      close_notes: closed
        ? `Implemented by KBR release ${input.release_id}. Promoted ${input.deployments?.length ?? 0} project(s) from QV to production.`
        : null,
      release: closed
        ? {
            id: input.release_id ?? null,
            status: 'succeeded',
            started_at: planned,
            finished_at: planned,
          }
        : { id: null, status: 'waiting', started_at: null, finished_at: null },
      related_incidents: [],
      opened_at: opened,
      updated_at: closed ? planned : opened,
      journal: [],
    };
    rec.journal.push(
      this.entry(
        'system',
        `Change request opened: ${CHANGE_TYPE_LABELS[type]} change for ${this.dir.appDisplay(app.tla)}\nMerge requests: ${rec.merge_requests.map((m) => m.reference).join(', ')}\nScheduled: KBR promotes QV to production at ${planned}`,
        requester,
        opened,
      ),
    );
    if (closed) {
      rec.journal.push(this.entry('work_note', deploymentNote(rec), KBR_USER, planned));
      rec.journal.push(
        this.entry(
          'system',
          'State changed from Implement to Closed\nClose code: Successful',
          KBR_USER,
          planned,
          [{ field: 'state', label: 'State', from: 'Implement', to: 'Closed' }],
        ),
      );
    }
    void now;
    this.add(rec);
    return rec;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private add(rec: ChangeRecord) {
    this.records.push(rec);
    this.byKey.set(rec.number, rec);
    this.byKey.set(rec.sys_id, rec);
  }

  private mergeRequests(inputs: ChangeMergeRequestInput[], tla: string): ChangeMergeRequest[] {
    const group = groupPathForTla(tla).toLowerCase();
    const out: ChangeMergeRequest[] = [];
    for (const input of inputs) {
      const ref = parseMergeRequestRef(input);
      if (!ref) {
        throw badRequest(
          `Invalid merge request '${typeof input === 'string' ? input : JSON.stringify(input)}'. Use keybank/${tla}00/<repo>!<iid> or the MR's GitLab URL.`,
        );
      }
      if (!ref.project.toLowerCase().startsWith(`${group}/`)) {
        throw badRequest(
          `${ref.project}!${ref.iid} is not in ${tla}'s GitLab group (${groupPathForTla(tla)}). A change request promotes one application; raise one per app.`,
        );
      }
      const reference = `${ref.project}!${ref.iid}`;
      if (out.some((m) => m.reference === reference)) continue;
      out.push({
        project: ref.project,
        iid: ref.iid,
        reference,
        web_url: mrWebUrl(ref.project, ref.iid),
        title: null,
        state: null,
        merge_commit_sha: null,
      });
    }
    return out;
  }

  private relatedIncidents(keys: string[]): string[] {
    return [...new Set(keys.map((k) => this.incidents.require(k).number))];
  }

  /** Work note on each related incident (they are in this same process). */
  private noteIncidents(
    rec: ChangeRecord,
    numbers: string[],
    text: string,
    at: string,
    author = rec.requested_by,
  ) {
    for (const n of numbers) {
      const inc = this.incidents.find(n);
      if (!inc) continue;
      inc.journal.push(
        this.entry('work_note', `${text}\n${serviceNowWebUrl.change(rec.number)}`, author, at),
      );
      inc.updated_at = at;
    }
  }

  private entry(
    type: JournalType,
    text: string,
    author: string,
    at: string,
    changes?: FieldChange[],
  ): JournalRecord {
    return {
      id: this.incidents.ids.journal(),
      type,
      text: text.trim(),
      author,
      created_at: at,
      ...(changes ? { changes } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  summary(r: ChangeRecord): ChangeRequestSummary {
    const d = this.dir;
    return {
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      type: r.type,
      state: r.state,
      risk: r.risk,
      app: d.appRef(r.app_tla),
      projects: [...new Set(r.merge_requests.map((m) => m.project))],
      merge_request_count: r.merge_requests.length,
      requested_by: d.userRef(r.requested_by),
      assignment_group: r.assignment_group ? d.groupRef(r.assignment_group) : null,
      planned_start: r.planned_start,
      implemented_at: r.implemented_at,
      close_code: r.close_code,
      release: { ...r.release },
      related_incidents: [...r.related_incidents],
      opened_at: r.opened_at,
      updated_at: r.updated_at,
      web_url: serviceNowWebUrl.change(r.number),
    };
  }

  full(r: ChangeRecord): ChangeRequest {
    const d = this.dir;
    return {
      ...this.summary(r),
      description: r.description,
      justification: r.justification,
      backout_plan: r.backout_plan,
      merge_requests: r.merge_requests.map((m) => ({ ...m })),
      deployments: r.deployments.map((x) => ({ ...x })),
      close_notes: r.close_notes,
      opened_by: d.userRef(r.opened_by),
      updated_by: d.userRef(r.updated_by),
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

const label = (s: ChangeState) => CHANGE_STATE_LABELS[s];

function describe(changes: FieldChange[]): string {
  return changes
    .map((c) => {
      if (c.field === 'description') return 'Description updated';
      if (c.field === 'merge_requests') return `Merge requests added: ${c.to}`;
      if (c.field === 'related_incidents') return `Related incidents added: ${c.to}`;
      return `${c.label} changed from ${c.from ?? '(empty)'} to ${c.to ?? '(empty)'}`;
    })
    .join('\n');
}

function deploymentNote(rec: ChangeRecord, extra?: string): string {
  const lines = rec.deployments.map(
    (d) =>
      `- ${d.project} @ ${d.short_sha}${d.service ? ` → ${d.service} ${d.version ?? ''}`.trimEnd() : ' (not a deployed workload)'}`,
  );
  return [
    `KBR release ${rec.release.id ?? ''} completed. Promoted from QV to production:`,
    ...lines,
    ...(extra ? ['', extra] : []),
  ].join('\n');
}

export function sortChanges(records: ChangeRecord[], sort: ChangeSort): ChangeRecord[] {
  const desc = sort.startsWith('-');
  const key = sort.replace(/^-/, '') as 'planned_start' | 'opened_at' | 'implemented_at' | 'number';
  const dir = desc ? -1 : 1;
  return [...records].sort((a, b) => {
    const x = a[key] ?? '';
    const y = b[key] ?? '';
    return dir * x.localeCompare(y) || dir * a.number.localeCompare(b.number);
  });
}
