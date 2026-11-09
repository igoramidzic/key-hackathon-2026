import type { FileEdit } from '@sim/contracts/gitlab';
import type { AlertInput, AlertSeverity, Severity } from '@sim/contracts/logs';
import type { IncidentCreateInput } from '@sim/contracts/servicenow';
import type { App, Rng, Stack } from '@sim/world';

export type { FileEdit };

/** Context handed to log templates when the simulator renders a log line. */
export interface LogContext {
  rng: Rng;
  app: App;
  /** Service (container) the line is emitted from. */
  service: string;
  now: Date;
  /** Seconds since the fault started for this app (0 at onset). */
  elapsedSec: number;
  /** Helpers for realistic values. */
  traceId(): string;
  /** Masked account number, e.g. `****4821`. */
  account(): string;
  /** Customer id, e.g. `C10458213`. */
  customerId(): string;
  /** Random request id / correlation id. */
  requestId(): string;
  /** Random ABA routing number (valid checksum). */
  routingNumber(): string;
  /** Random amount like `1,284.50`. */
  amount(): string;
}

/** What a template returns. The simulator wraps it into a full GCP LogEntry. */
export interface RenderedLog {
  message: string;
  logger?: string;
  thread?: string;
  error?: { type: string; message: string; stack_trace?: string };
  httpRequest?: {
    requestMethod: string;
    requestUrl: string;
    status: number;
    /** seconds */
    latencySec: number;
  };
  /** Extra jsonPayload fields. */
  fields?: Record<string, unknown>;
}

export interface LogTemplate {
  severity: Severity;
  /** Relative weight when an impact has several templates (default 1). */
  weight?: number;
  render(ctx: LogContext): RenderedLog;
}

/** The merged MR that causes the incident. Merged at trigger time. */
export interface ScenarioMr {
  project: string;
  title: string;
  /** Markdown. */
  description: string;
  author: string;
  mergedBy: string;
  approvers?: string[];
  sourceBranch: string;
  labels: string[];
  /** Applied to current main with find/replace or full content. */
  edits: FileEdit[];
  openedMinutesAgo?: number;
}

export interface ScenarioFix {
  title: string;
  /** Markdown, written like an engineer would. */
  description: string;
  /** The known-correct change, applied on top of main after the bad MR. */
  edits: FileEdit[];
  /** Files the predicate needs (read from `main` of `badMr.project`). */
  files: string[];
  /**
   * True once main contains a fix. Must be true after applying `edits` and also after a plain
   * revert of the bad MR; false while the bad change is live.
   */
  isFixed(files: Record<string, string | null>): boolean;
}

/** Errors/warnings an affected app emits while the fault is active. */
export interface AppImpact {
  tla: string;
  /** Defaults to the app's primary service. */
  service?: string;
  /** Seconds after fault onset before this app starts showing symptoms. */
  startAfterSec: number;
  /** Lines per second at full intensity (the simulator ramps up over ~20s). */
  ratePerSec: number;
  templates: LogTemplate[];
}

/**
 * Generic symptoms for every log-emitting app that directly depends on `upstreamTla` and is not
 * listed in `impacts`. Lets a cascade reach the long tail of generated apps.
 */
export interface FanoutImpact {
  upstreamTla: string;
  startAfterSec: number;
  ratePerSec: number;
  templates(app: App, stack: Stack): LogTemplate[];
}

export interface ScenarioAlert {
  /** Seconds after the bad MR merges. */
  atSec: number;
  alert: AlertInput;
  /** Re-sent every N seconds while the fault is active (bumps event_count). */
  repeatEverySec?: number;
}

export interface ScenarioHelpdeskCall {
  atSec: number;
  incident: IncidentCreateInput;
}

/** A non-causal change landing near the incident, to make root-cause analysis honest. */
export interface RedHerring {
  atSec: number;
  kind: 'merge' | 'commit';
  project: string;
  title: string;
  description?: string;
  author: string;
  mergedBy?: string;
  sourceBranch?: string;
  labels?: string[];
  edits: FileEdit[];
}

export type ScenarioKind = 'cascade' | 'single-app' | 'helpdesk';

export interface ScenarioDefinition {
  id: string;
  title: string;
  kind: ScenarioKind;
  /** One or two sentences, no spoilers. Shown on the control panel. */
  summary: string;
  /** Presenter-only explanation (shown behind a reveal on the control panel). */
  answerKey: {
    rootCause: string;
    culpritTla: string;
    affectedTlas: string[];
    /** Why the culprit still looks healthy. */
    whyItLooksGreen: string;
  };
  badMr: ScenarioMr;
  fix: ScenarioFix;
  /** Seconds between merge and the first symptoms (deploy rollout). */
  faultOnsetSec: number;
  /** Clue lines the culprit keeps emitting while the fault is active (usually INFO/WARNING). */
  culpritSignals?: { ratePerSec: number; templates: LogTemplate[] };
  impacts: AppImpact[];
  fanout?: FanoutImpact[];
  alerts: ScenarioAlert[];
  helpdesk?: ScenarioHelpdeskCall[];
  redHerrings?: RedHerring[];
}

export type { AlertSeverity };

/**
 * Code for a hero repo.
 * - `complete: true`: `files` is the whole source tree. GitLab only adds the standard scaffolding
 *   files it lacks (README.md, CHANGELOG.md, Dockerfile, .gitlab-ci.yml, .gitignore).
 * - `complete: false`: `files` are layered over the generated template (added or replaced).
 *
 * Path conventions shared with the GitLab template generator:
 * - java-spring: `pom.xml`, `src/main/java/com/keybank/<tla lowercase>/...`,
 *   `src/main/resources/application.yml`, `src/test/java/com/keybank/<tla lowercase>/...`
 * - node-ts: `package.json`, `tsconfig.json`, `src/index.ts`, `src/config.ts`, `src/routes/*.ts`,
 *   `src/clients/*.ts`, `test/*.test.ts`
 * - python: `pyproject.toml`, `src/<service name with _>/...py`, `tests/test_*.py`
 */
export interface RepoOverlay {
  complete: boolean;
  files: Record<string, string>;
}
