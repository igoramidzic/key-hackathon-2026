import { z } from 'zod';

const optionalUrl = z.preprocess((val) => {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return val;
}, z.string().url('Must be a valid URL string').optional());

const booleanFlag = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') return false;
  }
  return false;
}, z.boolean().default(false));

const positiveNumber = (defaultValue: number) =>
  z.preprocess(
    (val) => {
      if (val === undefined || val === null || val === '') return defaultValue;
      const num = Number(val);
      return Number.isFinite(num) ? num : val;
    },
    z
      .number({ message: 'Must be a positive number' })
      .positive({ message: 'Must be a positive number' }),
  );

export const RawEnvSchema = z.object({
  SIM_PUBLIC_URL: optionalUrl,
  SIM_HOST: z.string().trim().optional(),
  LOGS_MCP_URL: optionalUrl,
  SERVICENOW_MCP_URL: optionalUrl,
  GITLAB_MCP_URL: optionalUrl,
  TEAMS_MCP_URL: optionalUrl,
  LOG_STREAM_URL: optionalUrl,
  ACTIVITY_STREAM_URL: optionalUrl,
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  GEMINI_API_KEY: z.string().trim().optional(),
  ANTHROPIC_MODEL: z.string().trim().default('claude-3-7-sonnet-20250219'),
  GEMINI_MODEL: z.string().trim().default('gemini-2.5-flash'),
  AGENT_MODEL: z.string().trim().optional(),
  AGENT_DRY_RUN: booleanFlag,
  AGENT_AUTO_RESOLVE: booleanFlag,
  DETECTION_ERROR_THRESHOLD: positiveNumber(5),
  DETECTION_WINDOW_SECONDS: positiveNumber(60),
  DETECTION_WARNING_THRESHOLD: positiveNumber(20),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

export interface AgentConfig {
  simPublicUrl?: string;
  urls: {
    logsMcp: string;
    servicenowMcp: string;
    gitlabMcp: string;
    teamsMcp: string;
    logStream: string;
    activityStream: string;
    mcp: {
      logs: string;
      servicenow: string;
      gitlab: string;
      teams: string;
    };
    streams: {
      logs: string;
      activity: string;
    };
  };
  keys: {
    anthropic?: string;
    gemini?: string;
  };
  models: {
    anthropic: string;
    gemini: string;
    agent: string;
  };
  dryRun: boolean;
  autoResolve: boolean;
  thresholds: {
    errorThreshold: number;
    windowSeconds: number;
    warningThreshold: number;
  };
}

export class ConfigError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function formatConfigIssues(issues: z.ZodIssue[]): string {
  const lines = issues.map((issue) => {
    const field = issue.path.join('.');
    return field ? `  - ${field}: ${issue.message}` : `  - ${issue.message}`;
  });
  return `Invalid incident agent configuration:\n${lines.join('\n')}`;
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = RawEnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    throw new ConfigError(formatConfigIssues(parsed.error.issues), parsed.error.issues);
  }

  const raw = parsed.data;
  const simPublicUrl = raw.SIM_PUBLIC_URL?.replace(/\/+$/, '');
  const host = raw.SIM_HOST?.trim() || 'localhost';

  const defaultLogsMcp = simPublicUrl ? `${simPublicUrl}/logs/mcp` : `http://${host}:5001/mcp`;
  const defaultServiceNowMcp = simPublicUrl
    ? `${simPublicUrl}/servicenow/mcp`
    : `http://${host}:5002/mcp`;
  const defaultGitLabMcp = simPublicUrl ? `${simPublicUrl}/gitlab/mcp` : `http://${host}:5003/mcp`;
  const defaultTeamsMcp = simPublicUrl ? `${simPublicUrl}/teams/mcp` : `http://${host}:5004/mcp`;
  const defaultLogStream = simPublicUrl
    ? `${simPublicUrl}/logs/api/logs/stream`
    : `http://${host}:4001/api/logs/stream`;
  const defaultActivityStream = simPublicUrl
    ? `${simPublicUrl}/servicenow/api/activity/stream`
    : `http://${host}:4002/api/activity/stream`;

  const logsMcp = raw.LOGS_MCP_URL || defaultLogsMcp;
  const servicenowMcp = raw.SERVICENOW_MCP_URL || defaultServiceNowMcp;
  const gitlabMcp = raw.GITLAB_MCP_URL || defaultGitLabMcp;
  const teamsMcp = raw.TEAMS_MCP_URL || defaultTeamsMcp;
  const logStream = raw.LOG_STREAM_URL || defaultLogStream;
  const activityStream = raw.ACTIVITY_STREAM_URL || defaultActivityStream;

  return {
    simPublicUrl,
    urls: {
      logsMcp,
      servicenowMcp,
      gitlabMcp,
      teamsMcp,
      logStream,
      activityStream,
      mcp: {
        logs: logsMcp,
        servicenow: servicenowMcp,
        gitlab: gitlabMcp,
        teams: teamsMcp,
      },
      streams: {
        logs: logStream,
        activity: activityStream,
      },
    },
    keys: {
      anthropic: raw.ANTHROPIC_API_KEY || undefined,
      gemini: raw.GEMINI_API_KEY || undefined,
    },
    models: {
      anthropic: raw.ANTHROPIC_MODEL,
      gemini: raw.GEMINI_MODEL,
      agent: raw.AGENT_MODEL || raw.ANTHROPIC_MODEL,
    },
    dryRun: raw.AGENT_DRY_RUN ?? false,
    autoResolve: raw.AGENT_AUTO_RESOLVE ?? false,
    thresholds: {
      errorThreshold: raw.DETECTION_ERROR_THRESHOLD,
      windowSeconds: raw.DETECTION_WINDOW_SECONDS,
      warningThreshold: raw.DETECTION_WARNING_THRESHOLD,
    },
  };
}

let cachedConfig: AgentConfig | null = null;

export function getConfig(): AgentConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}
