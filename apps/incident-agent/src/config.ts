/**
 * Agent configuration from the environment, validated once at start.
 *
 * Local by default (the multi-port world from `pnpm dev`). With SIM_PUBLIC_URL set, every system
 * is reached under a path prefix on that origin (the hosted Cloudflare worker):
 *   MCP          <base>/<system>/mcp
 *   log stream   <base>/logs/api/logs/stream
 *   SNOW feed    <base>/servicenow/api/activity/tail
 * The simulator API (the answer key) is deliberately not part of this config.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathUrls, type SystemName, serviceUrls } from '@sim/contracts';
import { z } from 'zod';

export const SERVERS = ['logs', 'servicenow', 'gitlab', 'teams'] as const satisfies SystemName[];
export type ServerName = (typeof SERVERS)[number];

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected true/false, got "${v}"` });
      return z.NEVER;
    });

const num = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min) {
        ctx.addIssue({ code: 'custom', message: `expected a number >= ${min}, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const url = z.url().optional();

const EnvSchema = z.object({
  SIM_PUBLIC_URL: url,
  SIM_HOST: z.string().min(1).optional(),
  AGENT_LOGS_MCP_URL: url,
  AGENT_SERVICENOW_MCP_URL: url,
  AGENT_GITLAB_MCP_URL: url,
  AGENT_TEAMS_MCP_URL: url,
  AGENT_LOGS_API_URL: url,
  AGENT_SERVICENOW_API_URL: url,

  /**
   * `claude` (default): the AI phases investigate with Claude. `off` (or `deterministic`, or the
   * `--deterministic` flag): deterministic heuristics only, no model. `auto` is accepted as an
   * alias of `claude` for older setups.
   */
  AGENT_LLM: z
    .enum(['claude', 'off', 'deterministic', 'auto'])
    .default('claude')
    .transform((v) => (v === 'deterministic' ? 'off' : v === 'auto' ? 'claude' : v)),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  AGENT_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  AGENT_MODEL_DEEP: z.string().min(1).default('claude-opus-5-5'),

  AGENT_DRY_RUN: bool(false),
  AGENT_AUTO_RESOLVE: bool(false),
  /**
   * true: the emergency change is left as a draft and its link is posted in the chat, so a person
   * reviews (and edits) it and promotes it in ServiceNow. false: the agent schedules it itself.
   */
  AGENT_CHANGE_REVIEW: bool(false),
  /** false: no Critical Incident Communication drafts (the NEW and the RESTORED email). */
  AGENT_COMMUNICATIONS: bool(true),
  AGENT_DATA_DIR: z.string().min(1).optional(),
  AGENT_IDENTITY: z.string().min(1).default('svc_incident_auto'),
  /** Personas used only when the CMDB can't name anyone (AGENT-GUIDE §3). */
  AGENT_FALLBACK_COMMANDER: z.string().min(1).default('dwhitfield'),
  AGENT_FALLBACK_MIM: z.string().min(1).default('tokafor'),
  AGENT_FALLBACK_SERVICE_DESK: z.string().min(1).default('pnatarajan'),

  /**
   * Speed hint (the simulator's --speed). Divides settle windows, verification windows and poll
   * intervals so a 4x scenario is handled at 4x. Never changes what the agent decides.
   */
  AGENT_SPEED: num(1, 0.1),
  AGENT_TIMELINE_PORT: num(4100, 0),
  AGENT_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Detection (#13): per-(app, service) rolling windows over the log stream.
  AGENT_DETECT_WINDOW_SEC: num(60, 5),
  AGENT_DETECT_BASELINE_SEC: num(300, 30),
  AGENT_DETECT_K: num(4, 1),
  AGENT_DETECT_FLOOR_PER_MIN: num(12, 1),
  AGENT_DETECT_WARN_FLOOR_PER_MIN: num(20, 1),
  AGENT_DETECT_SUSTAIN_SEC: num(15, 0),
  AGENT_DETECT_NEW_TYPE_MIN: num(5, 1),

  // Correlation (#15)
  AGENT_SETTLE_SEC: num(30, 0),
  AGENT_JOIN_SCORE: num(0.6, 0),
  AGENT_TENTATIVE_SCORE: num(0.35, 0),
  AGENT_COOLDOWN_MIN: num(20, 0),
  AGENT_HUMAN_WINDOW_MIN: num(15, 1),

  // RCA / remediation
  AGENT_RCA_CONFIDENCE: num(0.6, 0),
  AGENT_VERIFY_HEALTHY_SEC: num(120, 10),
  AGENT_VERIFY_TIMEOUT_SEC: num(900, 30),
  AGENT_MAX_INVITES: num(8, 1),
});

export type Env = z.output<typeof EnvSchema>;

export interface AgentConfig {
  hosted: boolean;
  mcp: Record<ServerName, string>;
  /** UI bases, to recognise links that really point into the world. */
  web: Record<ServerName, string>;
  logsApi: string;
  serviceNowApi: string;
  llm: { mode: 'claude' | 'off'; model: string; deepModel: string; reason: string };
  dryRun: boolean;
  autoResolve: boolean;
  changeReview: boolean;
  communications: boolean;
  dataDir: string;
  identity: string;
  fallback: { commander: string; mim: string; serviceDesk: string };
  speed: number;
  timelinePort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  detect: {
    windowSec: number;
    baselineSec: number;
    k: number;
    floorPerMin: number;
    warnFloorPerMin: number;
    sustainSec: number;
    newTypeMin: number;
  };
  correlate: {
    settleSec: number;
    join: number;
    tentative: number;
    cooldownMin: number;
    humanWindowMin: number;
  };
  rcaConfidence: number;
  verify: { healthySec: number; timeoutSec: number };
  maxInvites: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates the environment. Throws ConfigError with every problem listed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid agent configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const base = e.SIM_PUBLIC_URL ? pathUrls(e.SIM_PUBLIC_URL) : serviceUrls(e.SIM_HOST);

  const mode: 'claude' | 'off' = e.AGENT_LLM === 'off' ? 'off' : 'claude';
  const credentials = e.ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY'
    : e.CLAUDE_CODE_OAUTH_TOKEN
      ? 'CLAUDE_CODE_OAUTH_TOKEN'
      : 'the Claude Code login';
  const reason =
    mode === 'off'
      ? 'deterministic mode (AGENT_LLM=off / --deterministic): no model'
      : `Claude via the Agent SDK, using ${credentials}`;

  const speed = e.AGENT_SPEED;
  return {
    hosted: Boolean(e.SIM_PUBLIC_URL),
    mcp: {
      logs: e.AGENT_LOGS_MCP_URL ?? base.logs.mcp,
      servicenow: e.AGENT_SERVICENOW_MCP_URL ?? base.servicenow.mcp,
      gitlab: e.AGENT_GITLAB_MCP_URL ?? base.gitlab.mcp,
      teams: e.AGENT_TEAMS_MCP_URL ?? base.teams.mcp,
    },
    web: {
      logs: base.logs.web,
      servicenow: base.servicenow.web,
      gitlab: base.gitlab.web,
      teams: base.teams.web,
    },
    logsApi: (e.AGENT_LOGS_API_URL ?? base.logs.api).replace(/\/+$/, ''),
    serviceNowApi: (e.AGENT_SERVICENOW_API_URL ?? base.servicenow.api).replace(/\/+$/, ''),
    llm: { mode, model: e.AGENT_MODEL, deepModel: e.AGENT_MODEL_DEEP, reason },
    dryRun: e.AGENT_DRY_RUN,
    autoResolve: e.AGENT_AUTO_RESOLVE,
    changeReview: e.AGENT_CHANGE_REVIEW,
    communications: e.AGENT_COMMUNICATIONS,
    dataDir: path.resolve(e.AGENT_DATA_DIR ?? path.join(PACKAGE_DIR, '.data')),
    identity: e.AGENT_IDENTITY,
    fallback: {
      commander: e.AGENT_FALLBACK_COMMANDER,
      mim: e.AGENT_FALLBACK_MIM,
      serviceDesk: e.AGENT_FALLBACK_SERVICE_DESK,
    },
    speed,
    timelinePort: e.AGENT_TIMELINE_PORT,
    logLevel: e.AGENT_LOG_LEVEL,
    detect: {
      windowSec: e.AGENT_DETECT_WINDOW_SEC,
      baselineSec: e.AGENT_DETECT_BASELINE_SEC,
      k: e.AGENT_DETECT_K,
      floorPerMin: e.AGENT_DETECT_FLOOR_PER_MIN,
      warnFloorPerMin: e.AGENT_DETECT_WARN_FLOOR_PER_MIN,
      sustainSec: e.AGENT_DETECT_SUSTAIN_SEC / speed,
      newTypeMin: e.AGENT_DETECT_NEW_TYPE_MIN,
    },
    correlate: {
      settleSec: e.AGENT_SETTLE_SEC / speed,
      join: e.AGENT_JOIN_SCORE,
      tentative: e.AGENT_TENTATIVE_SCORE,
      cooldownMin: e.AGENT_COOLDOWN_MIN,
      humanWindowMin: e.AGENT_HUMAN_WINDOW_MIN,
    },
    rcaConfidence: e.AGENT_RCA_CONFIDENCE,
    verify: {
      healthySec: e.AGENT_VERIFY_HEALTHY_SEC / speed,
      timeoutSec: e.AGENT_VERIFY_TIMEOUT_SEC,
    },
    maxInvites: e.AGENT_MAX_INVITES,
  };
}
