import { badRequest, conflict, notFound } from '@sim/api-kit';
import {
  COMMUNICATION_FROM,
  COMMUNICATION_KIND_LABELS,
  type Communication,
  type CommunicationDraftInput,
  type CommunicationKind,
  type CommunicationSendInput,
  type CommunicationState,
  type CommunicationSummary,
  communicationGroup,
  communicationNumber,
  type Priority,
  priorityFor,
  serviceNowWebUrl,
} from '@sim/contracts/servicenow';
import { PERSONAS, SHARED_GROUP_IDS } from '@sim/world';
import type { Directory } from './directory';
import type { IncidentStore } from './incidents';
import { DEFAULT_ACTOR, minutesBetween, parseWhen } from './model';

export const FIRST_COMMUNICATION_NUMBER = 50001;

/** Internal communication row: references are stored as keys (username, TLA, INC number). */
export interface CommunicationRecord {
  number: string;
  /** Incident number. */
  incident: string;
  kind: CommunicationKind;
  state: CommunicationState;
  /** Frozen when sent; a draft's subject is worked out when it is read. */
  subject: string;
  to: string;
  priority: Priority;
  title: string;
  start: string;
  resolved: string | null;
  systems_impacted: string[];
  description: string;
  client_impact: string | null;
  employee_impact: string | null;
  cause: string | null;
  resolution_activities: string | null;
  incident_manager: string | null;
  communication_specialist: string | null;
  technology_owners: string[];
  drafted_by: string;
  sent_by: string | null;
  drafted_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface CommunicationFilter {
  incident?: string;
  state?: CommunicationState;
  kind?: CommunicationKind;
}

/**
 * Critical Incident Communications: the email to an internal distribution group about an
 * incident. Automation (or the Communication Specialist) drafts; only a person sends.
 */
export class CommunicationStore {
  records: CommunicationRecord[] = [];
  private byNumber = new Map<string, CommunicationRecord>();
  private nextNumber = FIRST_COMMUNICATION_NUMBER;

  constructor(
    private readonly dir: Directory,
    private readonly incidents: IncidentStore,
  ) {}

  /** Empty: communications only exist for incidents worked since the last reset. */
  reset() {
    this.records = [];
    this.byNumber.clear();
    this.nextNumber = FIRST_COMMUNICATION_NUMBER;
  }

  find(key: string): CommunicationRecord | undefined {
    return this.byNumber.get(key.trim().toUpperCase());
  }

  require(key: string): CommunicationRecord {
    const rec = this.find(key);
    if (!rec) {
      throw notFound(
        `Critical Incident Communication ${key} not found (use a CIC number like CIC0050001)`,
      );
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Newest first. */
  list(filter: CommunicationFilter): CommunicationRecord[] {
    const incident = filter.incident ? this.incidents.require(filter.incident).number : undefined;
    return this.records
      .filter(
        (r) =>
          (!incident || r.incident === incident) &&
          (!filter.state || r.state === filter.state) &&
          (!filter.kind || r.kind === filter.kind),
      )
      .sort((a, b) => b.drafted_at.localeCompare(a.drafted_at) || b.number.localeCompare(a.number));
  }

  /** Communications of one incident, oldest first. */
  forIncident(number: string): CommunicationRecord[] {
    return this.records
      .filter((r) => r.incident === number)
      .sort((a, b) => a.drafted_at.localeCompare(b.drafted_at) || a.number.localeCompare(b.number));
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Drafts the communication of one kind for an incident. While a draft of that kind is unsent,
   * drafting again replaces it in place (same number); a sent one is never touched.
   */
  draft(
    incidentKey: string,
    input: CommunicationDraftInput,
    now = new Date(),
  ): { rec: CommunicationRecord; created: boolean } {
    const inc = this.incidents.require(incidentKey);
    const author = this.dir.requireUser(input.drafted_by ?? DEFAULT_ACTOR, 'drafted_by').username;
    const at = now.toISOString();
    const priority = priorityFor(inc.impact, inc.urgency);
    const mim = this.dir.world.groupsById.get(SHARED_GROUP_IDS.majorIncident);
    const app = inc.app_tla ? this.dir.world.appsByTla.get(inc.app_tla) : undefined;
    const user = (key: string | undefined, field: string, fallback: string | undefined) =>
      key ? this.dir.requireUser(key, field).username : (fallback ?? null);
    const text = (v: string | undefined) => v?.trim() || null;
    const unique = (values: string[]) => [...new Set(values)];

    const start = input.start
      ? parseWhen(input.start, 'start', now)
      : (inc.outage_start ?? inc.opened_at);
    const resolved =
      input.kind !== 'restored'
        ? null
        : input.resolved
          ? parseWhen(input.resolved, 'resolved', now)
          : (inc.service_restored_at ?? at);
    const fields = {
      kind: input.kind,
      to: input.to?.trim() || communicationGroup(priority),
      priority,
      title: input.title?.trim() || inc.short_description,
      start,
      resolved,
      systems_impacted: input.systems_impacted
        ? unique(input.systems_impacted.map((t) => this.dir.requireApp(t, 'systems_impacted').tla))
        : unique([...(inc.app_tla ? [inc.app_tla] : []), ...inc.affected_cis]),
      description: input.description.trim(),
      client_impact: text(input.client_impact) ?? inc.client_impact,
      employee_impact: text(input.employee_impact) ?? inc.employee_impact,
      cause: text(input.cause),
      resolution_activities: text(input.resolution_activities),
      incident_manager: user(input.incident_manager, 'incident_manager', mim?.onCall.primary),
      communication_specialist: user(
        input.communication_specialist,
        'communication_specialist',
        mim?.onCall.secondary,
      ),
      technology_owners: input.technology_owners
        ? unique(
            input.technology_owners.map(
              (u) => this.dir.requireUser(u, 'technology_owners').username,
            ),
          )
        : app
          ? [app.ownerUsername]
          : [],
      drafted_by: author,
      updated_at: at,
    };

    const existing = this.records.find(
      (r) => r.incident === inc.number && r.kind === input.kind && r.state === 'draft',
    );
    let rec: CommunicationRecord;
    if (existing) {
      rec = Object.assign(existing, fields);
    } else {
      rec = {
        number: communicationNumber(this.nextNumber++),
        incident: inc.number,
        state: 'draft',
        subject: '',
        sent_by: null,
        drafted_at: at,
        sent_at: null,
        ...fields,
      };
      this.records.push(rec);
      this.byNumber.set(rec.number, rec);
    }
    rec.subject = this.subjectFor(rec);
    this.incidents.addJournal(
      inc.number,
      {
        type: 'work_note',
        text: `Critical Incident Communication ${rec.number} ${existing ? 'draft updated' : 'drafted'} (${this.tag(rec)}) for ${rec.to} — awaiting review and send: ${serviceNowWebUrl.communication(rec.number)}`,
        author,
      },
      now,
    );
    return { rec, created: !existing };
  }

  /** A person sends the draft to the distribution group (the web UI; there is no tool for it). */
  send(key: string, input: CommunicationSendInput = {}, now = new Date()): CommunicationRecord {
    const rec = this.require(key);
    if (rec.state === 'sent') {
      throw conflict(
        `${rec.number} was already sent to ${rec.to} at ${rec.sent_at}. A sent communication cannot be changed or sent again; draft a new one for a follow-up.`,
      );
    }
    const sender = input.sent_by
      ? this.dir.requireUser(input.sent_by, 'sent_by')
      : this.dir.requireUser(rec.communication_specialist ?? PERSONAS.nocLead, 'sent_by');
    if (sender.role === 'bot') {
      throw badRequest(
        `${sender.username} is a service account. A Critical Incident Communication is reviewed and sent by a person (the Communication Specialist).`,
      );
    }
    const at = now.toISOString();
    rec.subject = this.subjectFor(rec);
    rec.state = 'sent';
    rec.sent_at = at;
    rec.sent_by = sender.username;
    rec.updated_at = at;
    if (this.incidents.find(rec.incident)) {
      this.incidents.addJournal(
        rec.incident,
        {
          type: 'work_note',
          text: `Critical Incident Communication ${rec.number} sent to ${rec.to} by ${sender.name}\n${rec.subject}`,
          author: sender.username,
        },
        now,
      );
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // Subject
  // -------------------------------------------------------------------------

  /**
   * NEW, UPDATE or RESTORED. Service restored before anything was sent about the incident is
   * the first the distribution group hears of it: NEW/RESTORED.
   */
  private tag(rec: CommunicationRecord): string {
    const announced = this.records.some(
      (r) => r !== rec && r.incident === rec.incident && r.state === 'sent',
    );
    return rec.kind === 'restored' && !announced
      ? `${COMMUNICATION_KIND_LABELS.new}/${COMMUNICATION_KIND_LABELS.restored}`
      : COMMUNICATION_KIND_LABELS[rec.kind];
  }

  private subjectFor(rec: CommunicationRecord): string {
    return `<page> ${this.tag(rec)} - ${rec.incident} - ${rec.title}`;
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  summary(r: CommunicationRecord): CommunicationSummary {
    return {
      number: r.number,
      incident: r.incident,
      kind: r.kind,
      state: r.state,
      // A draft follows what has been sent since it was written; a sent subject is final.
      subject: r.state === 'sent' ? r.subject : this.subjectFor(r),
      to: r.to,
      priority: r.priority,
      drafted_at: r.drafted_at,
      updated_at: r.updated_at,
      sent_at: r.sent_at,
      web_url: serviceNowWebUrl.communication(r.number),
    };
  }

  full(r: CommunicationRecord): Communication {
    const d = this.dir;
    return {
      ...this.summary(r),
      from: COMMUNICATION_FROM,
      title: r.title,
      start: r.start,
      resolved: r.resolved,
      duration_minutes: r.resolved ? minutesBetween(r.start, r.resolved) : null,
      systems_impacted: r.systems_impacted.map((tla) => d.appRef(tla)),
      description: r.description,
      client_impact: r.client_impact,
      employee_impact: r.employee_impact,
      cause: r.cause,
      resolution_activities: r.resolution_activities,
      incident_manager: r.incident_manager ? d.userRef(r.incident_manager) : null,
      communication_specialist: r.communication_specialist
        ? d.userRef(r.communication_specialist)
        : null,
      technology_owners: r.technology_owners.map((u) => d.userRef(u)),
      drafted_by: d.userRef(r.drafted_by),
      sent_by: r.sent_by ? d.userRef(r.sent_by) : null,
    };
  }
}
