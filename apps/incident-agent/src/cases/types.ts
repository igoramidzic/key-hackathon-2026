/**
 * A case is one problem the agent is working on, from first signal to resolution. Everything the
 * agent knows about it lives here and is persisted, so a restart picks up where it left off.
 * The report schemas double as the JSON contracts for the LLM phases.
 */
import { z } from 'zod';

export const PHASES = [
  'detected', // pending: settle window, nothing created yet
  'triaged',
  'declared', // ServiceNow incident exists
  'assembled', // Teams channel exists
  'briefed',
  'investigating', // deep RCA in the background
  'fix_proposed',
  'awaiting_merge',
  'shipping', // emergency CHG raised, waiting for KBR
  'verifying',
  'resolution_drafted',
  'resolved',
  'failed',
  'abandoned',
] as const;
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

export const TERMINAL: readonly Phase[] = ['resolved', 'failed', 'abandoned'];
export const isTerminal = (p: Phase) => TERMINAL.includes(p);

// ---------------------------------------------------------------------------
// Signals (#13, #14)
// ---------------------------------------------------------------------------

export const LogSignal = z.object({
  source: z.literal('logs'),
  id: z.string(),
  at: z.string(),
  app_tla: z.string(),
  service: z.string(),
  /** spike: error rate above baseline; new_error_type: an error type never seen for the app;
   *  warning_spike: WARNING-only rise (weak). */
  reason: z.enum(['spike', 'new_error_type', 'warning_spike']),
  strength: z.enum(['strong', 'weak']),
  error_types: z.array(z.string()),
  first_seen: z.string(),
  count: z.number(),
  /** Per minute over the detection window. */
  rate: z.number(),
  baseline: z.number().default(0),
  sample_insert_ids: z.array(z.string()),
  traces: z.array(z.string()).default([]),
  sample_messages: z.array(z.string()).default([]),
  /** Logs Explorer query that reproduces the signal. */
  filter: z.string(),
});
export type LogSignal = z.infer<typeof LogSignal>;

export const HumanSignal = z.object({
  source: z.literal('human'),
  id: z.string(),
  at: z.string(),
  incident_number: z.string(),
  short_description: z.string(),
  description: z.string(),
  caller: z.string().nullable(),
  location: z.string().nullable().default(null),
  contact_type: z.string(),
  app_tla: z.string().nullable().default(null),
  impact: z.number().nullable().default(null),
  urgency: z.number().nullable().default(null),
  web_url: z.string(),
});
export type HumanSignal = z.infer<typeof HumanSignal>;

export const AlertSignal = z.object({
  source: z.literal('alert'),
  id: z.string(),
  at: z.string(),
  alert_id: z.number(),
  app_tla: z.string(),
  service: z.string(),
  severity: z.string(),
  description: z.string(),
  web_url: z.string(),
});
export type AlertSignal = z.infer<typeof AlertSignal>;

export const Signal = z.discriminatedUnion('source', [LogSignal, HumanSignal, AlertSignal]);
export type Signal = z.infer<typeof Signal>;

// ---------------------------------------------------------------------------
// Phase outputs (#15 – #24)
// ---------------------------------------------------------------------------

export const Relation = z.object({
  tla: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  tentative: z.boolean().default(false),
});
export type Relation = z.infer<typeof Relation>;

export const UpstreamCandidate = z.object({
  tla: z.string(),
  name: z.string().default(''),
  /** How many of the case's failing apps it is upstream of (or is). */
  covers: z.number(),
  of: z.number(),
  /** Max hops from a failing app it covers. */
  hops: z.number(),
  /** Whether the candidate itself is failing. */
  failing: z.boolean(),
});
export type UpstreamCandidate = z.infer<typeof UpstreamCandidate>;

export const ScopeReport = z.object({
  summary: z
    .string()
    .describe(
      'Plain-English headline for the incident, e.g. "Online and mobile banking customer lookups failing"',
    ),
  affected_apps: z.array(
    z.object({
      tla: z.string(),
      name: z.string(),
      tier: z.number(),
      services: z.array(z.string()),
      error_count: z.number(),
      onset: z.string().describe('ISO time this app started failing'),
    }),
  ),
  onset: z.string().describe('ISO time the problem started (earliest affected app)'),
  signatures: z.array(
    z.object({
      app_tla: z.string().default(''),
      error_type: z.string(),
      message: z.string(),
      sample_insert_id: z.string(),
      stack_excerpt: z.string().default(''),
    }),
  ),
  customer_impact: z.string().describe('One plain-English sentence'),
  suggested_impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  suggested_urgency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  severity_reason: z.string(),
  log_links: z
    .array(z.object({ label: z.string(), filter: z.string(), logs_url: z.string() }))
    .describe('1-3 links; logs_url copied from the search_logs / summarize_errors response'),
  grouping: z.array(z.object({ tla: z.string(), belongs: z.boolean(), reason: z.string() })),
});
export type ScopeReport = z.infer<typeof ScopeReport>;

const ChangeRef = z.object({ number: z.string(), web_url: z.string() });
const MrRef = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string().default(''),
  web_url: z.string(),
});
export type MrRef = z.infer<typeof MrRef>;

export const Suspect = z.object({
  tla: z.string(),
  change_request: ChangeRef.nullable(),
  merge_request: MrRef.nullable(),
  promoted_at: z.string().nullable(),
  author: z.string().nullable(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Suspect = z.infer<typeof Suspect>;

export const RootCause = z.object({
  culprit_tla: z.string(),
  change_request: ChangeRef.nullable(),
  merge_request: MrRef.nullable(),
  commit: z.object({ sha: z.string(), web_url: z.string() }).nullable(),
  files: z.array(z.string()),
  mechanism: z.string().describe('How the change produces the observed errors'),
  evidence: z.array(z.object({ claim: z.string(), web_url: z.string() })),
  ruled_out: z.array(z.object({ ref: z.string(), reason: z.string() })),
  unexplained_apps: z.array(z.object({ tla: z.string(), reason: z.string() })).default([]),
  confidence: z.number().min(0).max(1),
});
export type RootCause = z.infer<typeof RootCause>;

export const FileChange = z.object({
  path: z.string(),
  content: z.string().optional(),
  find: z.string().optional(),
  replace: z.string().optional(),
});
export type FileChange = z.infer<typeof FileChange>;

export const FixProposal = z.object({
  project: z.string(),
  strategy: z.enum(['revert', 'forward-fix']),
  justification: z.string(),
  changes: z.array(FileChange).min(1),
  title: z.string(),
  description: z.string(),
});
export type FixProposal = z.infer<typeof FixProposal>;

// ---------------------------------------------------------------------------
// Timeline and background work
// ---------------------------------------------------------------------------

export const TimelineEvent = z.object({
  at: z.string(),
  kind: z.enum([
    'phase',
    'signal',
    'tool',
    'decision',
    'action',
    'message',
    'llm',
    'error',
    'note',
  ]),
  text: z.string(),
  url: z.string().optional(),
  data: z.unknown().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const BackgroundTask = z.object({
  state: z.enum(['running', 'done', 'failed', 'canceled']),
  started_at: z.string(),
  finished_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  runs: z.number().default(1),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

const Member = z.object({ username: z.string(), reason: z.string(), role: z.string() });

export const Case = z.object({
  id: z.string(),
  kind: z.enum(['monitoring', 'human-reported']),
  phase: Phase,
  opened_at: z.string(),
  updated_at: z.string(),
  onset_at: z.string().nullable().default(null),
  /** Pending cases are triaged once this passes (#15 settle window). */
  settle_until: z.string().nullable().default(null),
  /** Hidden id written into the incident description, for idempotent lookups. */
  correlation_id: z.string(),
  /** ServiceNow feed epoch when the case opened; a different epoch means the world was reset. */
  epoch: z.number().nullable().default(null),

  apps: z.array(z.string()).default([]),
  relations: z.array(Relation).default([]),
  upstream_candidates: z.array(UpstreamCandidate).default([]),
  signals: z.array(Signal).default([]),

  scope: ScopeReport.nullable().default(null),
  suspects: z.array(Suspect).default([]),
  root_cause: RootCause.nullable().default(null),
  fix: FixProposal.nullable().default(null),

  incident: z
    .object({
      number: z.string(),
      web_url: z.string(),
      app_tla: z.string().nullable().default(null),
      assignment_group: z.string().nullable().default(null),
      priority: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
  channel: z
    .object({ id: z.string(), name: z.string(), web_url: z.string() })
    .nullable()
    .default(null),
  members: z.array(Member).default([]),
  fix_mr: z
    .object({
      project: z.string(),
      iid: z.number(),
      web_url: z.string(),
      state: z.string(),
      source_branch: z.string(),
      merged_at: z.string().nullable().default(null),
      merge_commit_sha: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  change: z
    .object({
      number: z.string(),
      web_url: z.string(),
      state: z.string(),
      deployed_at: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  alerts: z
    .array(
      z.object({
        id: z.number(),
        web_url: z.string(),
        app_tla: z.string(),
        linked: z.boolean().default(false),
        resolved: z.boolean().default(false),
      }),
    )
    .default([]),
  children: z.array(z.string()).default([]),
  /** Caller incidents considered and rejected (so we don't ask again). */
  not_children: z.array(z.string()).default([]),
  verification: z
    .object({
      before_per_min: z.number(),
      after_per_min: z.number().nullable().default(null),
      healthy_since: z.string().nullable().default(null),
      started_at: z.string(),
      logs_url: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  resolution: z
    .object({
      close_code: z.string(),
      close_notes: z.string(),
      drafted_at: z.string(),
      resolved_at: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  milestones: z.record(z.string(), z.string()).default({}),

  background: z.record(z.string(), BackgroundTask).default({}),
  attempts: z.record(z.string(), z.number()).default({}),
  failure: z.object({ reason: z.string(), phase: Phase, at: z.string() }).nullable().default(null),
  merged_into: z.string().nullable().default(null),
  split_from: z.string().nullable().default(null),
  last_regroup_at: z.string().nullable().default(null),
  chat_cursor: z.string().nullable().default(null),
  /** Last status message posted, to coalesce updates. */
  last_post_at: z.string().nullable().default(null),
  timeline: z.array(TimelineEvent).default([]),
});
export type Case = z.output<typeof Case>;
export type CaseInput = z.input<typeof Case>;

export const MAX_TIMELINE = 2_000;
