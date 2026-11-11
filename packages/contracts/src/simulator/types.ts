/**
 * Simulator engine REST types (`apps/simulator`, port 4000). Used by the control panel and the
 * `pnpm sim` CLI. JSON keys are snake_case like every other API.
 */
import type { FileEdit } from '../gitlab/types';
import type { AlertSeverity } from '../logs/types';

export type ScenarioKind = 'cascade' | 'single-app' | 'helpdesk';

export interface AnswerKey {
  root_cause: string;
  culprit_tla: string;
  affected_tlas: string[];
  why_it_looks_green: string;
}

/** `GET /api/scenarios` item. */
export interface ScenarioSummary {
  id: string;
  title: string;
  kind: ScenarioKind;
  summary: string;
  answer_key: AnswerKey;
  /** GitLab project of the bad MR, e.g. `keybank/CIF00/customer-profile-api`. */
  culprit_project: string;
  fault_onset_sec: number;
  impacted_tlas: string[];
  alert_count: number;
  helpdesk_count: number;
  red_herring_count: number;
}

export interface ScenarioMrDetail {
  project: string;
  title: string;
  description: string;
  author: string;
  merged_by: string;
  source_branch: string;
  labels: string[];
  edits: FileEdit[];
}

export interface ScenarioFixDetail {
  title: string;
  description: string;
  edits: FileEdit[];
  files: string[];
}

/** `GET /api/scenarios/:id` */
export interface ScenarioDetail extends ScenarioSummary {
  bad_mr: ScenarioMrDetail;
  fix: ScenarioFixDetail;
  impacts: { tla: string; service: string; start_after_sec: number; rate_per_sec: number }[];
  fanout: { upstream_tla: string; start_after_sec: number; rate_per_sec: number; apps: string[] }[];
  alerts: {
    at_sec: number;
    severity: AlertSeverity;
    app_tla: string;
    description: string;
    repeat_every_sec: number | null;
  }[];
  helpdesk: { at_sec: number; short_description: string; caller: string | null }[];
  red_herrings: { at_sec: number; kind: 'merge' | 'commit'; project: string; title: string }[];
}

/**
 * - `pending`: bad MR merged and promoted by KBR, rollout in progress (before fault onset)
 * - `degrading`: fault active
 * - `recovering`: KBR promoted a change containing the fix to production, errors ramping down
 * - `recovered`: errors gone, alerts resolved
 * - `stopped`: stopped by an operator (`POST /api/stop`, `--force`, reset)
 * - `failed`: the bad MR could not be merged (e.g. systems not reset since the last run)
 */
export type RunPhase = 'pending' | 'degrading' | 'recovering' | 'recovered' | 'stopped' | 'failed';

export const ACTIVE_RUN_PHASES: readonly RunPhase[] = ['pending', 'degrading', 'recovering'];

export function isRunActive(phase: RunPhase): boolean {
  return ACTIVE_RUN_PHASES.includes(phase);
}

export type RunEventKind =
  | 'merge'
  | 'change'
  | 'deploy'
  | 'fault'
  | 'alert'
  | 'helpdesk'
  | 'red_herring'
  | 'fix'
  | 'recovered'
  | 'stopped'
  | 'error'
  | 'info';

export interface RunEvent {
  /** ISO timestamp. */
  at: string;
  /** Seconds since the run started (wall clock, not scaled by speed). */
  offset_sec: number;
  kind: RunEventKind;
  message: string;
  url?: string;
}

export interface RunStatus {
  id: string;
  title: string;
  kind: ScenarioKind;
  phase: RunPhase;
  active: boolean;
  speed: number;
  started_at: string;
  /** Wall-clock seconds since start (frozen when the run ends). */
  elapsed_sec: number;
  fault_onset_at: string | null;
  fixed_at: string | null;
  recovered_at: string | null;
  ended_at: string | null;
  error: string | null;
  bad_mr: { web_url: string; sha: string; short_sha: string; iid: number } | null;
  fix_mr: { web_url: string; sha: string | null } | null;
  /** Change request KBR used to promote the bad MR to production. */
  bad_change: { number: string; web_url: string } | null;
  /** Change request whose promotion put the fix in production. */
  fix_change: { number: string; web_url: string } | null;
  /** When the fix was first seen on main (QV), before any promotion. */
  fix_on_main_at: string | null;
  helpdesk: { number: string; web_url: string; at: string }[];
  alerts: {
    id: number;
    web_url: string;
    severity: AlertSeverity;
    app_tla: string;
    description: string;
    resolved: boolean;
  }[];
  culprit_tla: string;
  affected_tlas: string[];
  /** Logs Explorer pre-filtered to the affected apps, severity>=WARNING, since the run started. */
  logs_url: string;
  events: RunEvent[];
}

export type EnginePhase = 'waiting_for_systems' | 'backfilling' | 'running' | 'resetting';

export interface TrafficStatus {
  paused: boolean;
  rate_multiplier: number;
  /** Lines ingested per second over the last ~10s (baseline + scenario). */
  lines_per_sec: number;
  total_lines: number;
  /** Lines waiting to be flushed (grows while the Logs API is down). */
  buffered: number;
  last_flush_at: string | null;
  ingest_errors: number;
  noise_merges: number;
  /** Change requests KBR promoted to production since the last reset. */
  kbr_releases: number;
  background_alerts: number;
}

export interface EndpointHealth {
  url: string;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
  stats: Record<string, number> | null;
  checked_at: string | null;
}

export interface SystemStatus {
  name: 'logs' | 'servicenow' | 'gitlab' | 'teams';
  label: string;
  ui_url: string;
  api: EndpointHealth;
  mcp: EndpointHealth;
}

/** `GET /api/status` */
export interface SimulatorStatus {
  engine: { phase: EnginePhase; started_at: string; message: string | null };
  /** The active run, or the last finished one (check `run.active`). */
  run: RunStatus | null;
  traffic: TrafficStatus;
  systems: SystemStatus[];
}

export interface TriggerInput {
  /** Divides every scenario offset (default 1). */
  speed?: number;
  /** Stop the active run first instead of failing with 409. */
  force?: boolean;
}

export interface TrafficInput {
  paused?: boolean;
  /** Scales baseline traffic (default 1, 0–10). */
  rate_multiplier?: number;
}

export interface ResetResponse {
  ok: boolean;
  reset_at: string;
  duration_ms: number;
  systems: { name: string; ok: boolean; error: string | null }[];
  backfilled_lines: number;
}

export interface StopResponse {
  run: RunStatus | null;
}
