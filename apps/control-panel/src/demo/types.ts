/**
 * What the incident agent's live timeline serves (`apps/incident-agent/src/timeline/view.ts`).
 * Declared structurally here: the control panel reads the agent's HTTP API and does not import it.
 */
import type { DemoTarget } from '@sim/ui';

export interface AgentInfo {
  speed?: number;
  llm?: string;
  auto_resolve?: boolean;
  dry_run?: boolean;
}

export interface AgentLink {
  label: string;
  url: string;
  system: 'logs' | 'servicenow' | 'gitlab' | 'teams' | null;
  title?: string;
}

export interface AgentEvent {
  at: string;
  kind: 'phase' | 'signal' | 'tool' | 'decision' | 'action' | 'message' | 'llm' | 'error' | 'note';
  text: string;
  links: AgentLink[];
}

export interface Hypothesis {
  source: 'root_cause' | 'suspect';
  tla: string;
  confidence: number;
  text: string;
  author: string | null;
  promoted_at: string | null;
  links: AgentLink[];
  evidence: AgentLink[];
  ruled_out: string[];
  unexplained: string[];
  others: { tla: string; confidence: number; change: string | null }[];
}

export interface CaseRecords {
  incident: {
    number: string;
    web_url: string;
    app_tla: string | null;
    assignment_group: string | null;
    priority: number | null;
  } | null;
  channel: { id: string; name: string; web_url: string } | null;
  members: { username: string; reason: string; role: string }[];
  fix_mr: {
    project: string;
    iid: number;
    web_url: string;
    state: string;
    merged_at: string | null;
  } | null;
  change: { number: string; web_url: string; state: string; deployed_at: string | null } | null;
  children: string[];
  callers: {
    number: string;
    web_url: string;
    short_description: string;
    caller: string | null;
    location: string | null;
    contact_type: string;
  }[];
  alerts: { id: number; web_url: string; app_tla: string; linked: boolean; resolved: boolean }[];
  scope: {
    summary: string;
    customer_impact: string;
    onset: string;
    impact: number;
    urgency: number;
    severity_reason: string;
    affected: { tla: string; name: string; tier: number; error_count: number }[];
  } | null;
  suspects: {
    tla: string;
    confidence: number;
    reason: string;
    change: string | null;
    merge_request: string | null;
  }[];
  culprit: {
    tla: string;
    confidence: number;
    change: { number: string; web_url: string } | null;
    merge_request: { project: string; iid: number; title: string; web_url: string } | null;
    files: string[];
  } | null;
  fix: { strategy: string; title: string; justification: string; files: string[] } | null;
  verification: {
    before_per_min: number;
    after_per_min: number | null;
    healthy_since: string | null;
    started_at: string;
    logs_url: string | null;
  } | null;
  resolution: {
    close_code: string;
    close_notes: string;
    drafted_at: string;
    resolved_at: string | null;
    fields?: Record<string, string>;
  } | null;
  meeting?: { id: string; started_at: string; ended_at: string | null; join_url: string } | null;
  communications?: {
    kind: 'new' | 'update' | 'restored';
    number: string;
    web_url: string;
    subject: string;
    to: string;
    specialist: string | null;
    drafted_at: string;
  }[];
  problem?: { number: string; web_url: string; standup_date: string | null } | null;
  milestones: Record<string, string>;
  signals: { logs: number; alerts: number; callers: number };
  cost_usd: number;
  tool_calls: number;
}

export interface CaseView {
  id: string;
  kind: 'monitoring' | 'human-reported';
  phase: string;
  open: boolean;
  opened_at: string;
  updated_at: string;
  onset_at: string | null;
  title: string;
  impact: string | null;
  apps: string[];
  hypothesis: Hypothesis | null;
  background: { name: string; label: string; started_at: string; runs: number }[];
  links: AgentLink[];
  failure: string | null;
  related: { label: string; id: string }[];
  records?: CaseRecords;
  log_links: AgentLink[];
  timeline: AgentEvent[];
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

export type ScreenId = 'logs' | 'alerts' | 'servicenow' | 'gitlab' | 'teams';

export type NativeView = 'intro' | 'blast' | 'triage' | 'rootcause' | 'recap';

export type Pane =
  | {
      kind: 'frame';
      screen: ScreenId;
      /** Absolute URL inside that system's UI. */
      url: string;
      /** What the pane is showing, for its title strip: "INC0010207". */
      what?: string;
      spots?: DemoTarget[];
      /** Click this first (e.g. open the members panel) unless `unless` is already on screen. */
      click?: { target: DemoTarget; unless?: DemoTarget };
    }
  | { kind: 'native'; view: NativeView };

export const CHAPTERS = [
  'Setup',
  'Detect',
  'Triage',
  'Mobilize',
  'Root cause',
  'Fix',
  'Ship',
  'Recover',
  'Close out',
] as const;
export type Chapter = (typeof CHAPTERS)[number];

export interface Beat {
  id: string;
  chapter: Chapter;
  /** What is happening, in a few words. */
  title: string;
  /** One plain sentence. */
  say: string;
  /** Has this happened in the live systems yet? */
  ready: boolean;
  /** When it happened (ISO), if the systems say. */
  at?: string | null;
  /** What is on stage: one thing. */
  panes: Pane[];
  /** Minimum seconds on screen before moving on by itself. */
  dwell: number;
  /** The presenter has to do something; the tour waits until `done`. */
  action?: { label: string; done: boolean };
  /** Skipped when it never happens (no callers, a single app, …). */
  optional?: boolean;
}
