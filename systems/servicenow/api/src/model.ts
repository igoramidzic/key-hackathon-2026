import { badRequest, parseTime } from '@sim/api-kit';
import type {
  CauseCode,
  CloseCode,
  ContactType,
  FieldChange,
  ImpactUrgency,
  IncidentState,
  JournalType,
  LinkType,
} from '@sim/contracts/servicenow';
import { PERSONAS } from '@sim/world';

/** Who acts when a request doesn't say (the incident automation service account). */
export const DEFAULT_ACTOR = PERSONAS.incidentBot;
export const FIRST_NUMBER = 10001;

export const incidentNumber = (n: number) => `INC${String(n).padStart(7, '0')}`;

export interface JournalRecord {
  id: string;
  type: JournalType;
  text: string;
  author: string;
  created_at: string;
  changes?: FieldChange[];
}

export interface LinkRecord {
  id: string;
  type: LinkType;
  url: string;
  title: string;
  added_by: string;
  added_at: string;
}

/** Internal incident row: references are stored as keys (username, group id, TLA). */
export interface IncidentRecord {
  sys_id: string;
  number: string;
  short_description: string;
  description: string;
  state: IncidentState;
  impact: ImpactUrgency;
  urgency: ImpactUrgency;
  category: string;
  subcategory: string | null;
  app_tla: string | null;
  caller: string | null;
  opened_by: string;
  contact_type: ContactType;
  assignment_group: string | null;
  assigned_to: string | null;
  opened_at: string;
  updated_at: string;
  updated_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  closed_at: string | null;
  close_code: CloseCode | null;
  close_notes: string | null;
  reassignment_count: number;
  reopen_count: number;
  /** Parent incident number when this incident is a child. Children cannot have children. */
  parent_incident: string | null;
  /** Other affected applications (TLAs, upper case), never the incident's own `app_tla`. */
  affected_cis: string[];
  // Resolution section
  outage_start: string | null;
  service_restored_at: string | null;
  cause_code: CauseCode | null;
  /** CHG numbers. */
  caused_by_change: string | null;
  resolved_by_change: string | null;
  root_cause: string | null;
  client_impact: string | null;
  employee_impact: string | null;
  /** PRB number, set by the problem store. */
  problem: string | null;
  links: LinkRecord[];
  journal: JournalRecord[];
}

/** The Affected CIs and Resolution fields of a new incident: nothing filled in yet. */
export const emptyResolution = () => ({
  affected_cis: [] as string[],
  outage_start: null,
  service_restored_at: null,
  cause_code: null,
  caused_by_change: null,
  resolved_by_change: null,
  root_cause: null,
  client_impact: null,
  employee_impact: null,
  problem: null,
});

/** A point in time from a client: `now`, an ISO time, or how long ago (`15m`, `2h`, `1d`). */
export function parseWhen(value: string, field: string, now = new Date()): string {
  const v = value.trim();
  if (v.toLowerCase() === 'now') return now.toISOString();
  let date: Date | undefined;
  try {
    date = parseTime(v, now);
  } catch {
    date = undefined;
  }
  if (!date) {
    throw badRequest(
      `Invalid ${field} '${value}' (use an ISO time such as 2026-11-12T14:05:00Z, "now", or how long ago like "15m" or "2h")`,
    );
  }
  return date.toISOString();
}

/** Whole minutes between two ISO times, never negative. */
export function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

/** One-line preview of a long text for journal entries. */
export function clip(text: string, max = 140): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export interface IdGen {
  journal(): string;
  link(): string;
}
