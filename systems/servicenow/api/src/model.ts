import type {
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
  links: LinkRecord[];
  journal: JournalRecord[];
}

export interface IdGen {
  journal(): string;
  link(): string;
}
