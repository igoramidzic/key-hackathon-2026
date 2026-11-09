import type { Health } from '@sim/contracts';
import { PORTS, SYSTEM_LABELS, SYSTEMS, type SystemName, serviceUrls, URLS } from '@sim/contracts';
import { createGitlabClient, type GitlabClient } from '@sim/contracts/gitlab';
import { createLogsClient, type LogsClient } from '@sim/contracts/logs';
import { createServiceNowClient, type ServiceNowClient } from '@sim/contracts/servicenow';
import type { EndpointHealth } from '@sim/contracts/simulator';
import { createTeamsClient, type TeamsClient } from '@sim/contracts/teams';

/** Where each system lives. Every URL can be overridden with env vars. */
export interface SystemEndpoints {
  name: SystemName;
  label: string;
  api: string;
  mcp: string;
  /** MCP server's `GET /health`. */
  mcpHealth: string;
  web: string;
}

export interface SimulatorConfig {
  port: number;
  systems: Record<SystemName, SystemEndpoints>;
  skipBackfill: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SimulatorConfig {
  // URLS honours single-origin hosting (configureUrls / SIM_PUBLIC_URL); SIM_HOST forces multi-port.
  const defaults = env.SIM_HOST ? serviceUrls(env.SIM_HOST) : URLS;
  const systems = {} as Record<SystemName, SystemEndpoints>;
  for (const name of SYSTEMS) {
    const upper = name.toUpperCase();
    const mcp = env[`${upper}_MCP_URL`] ?? defaults[name].mcp;
    const mcpBase = mcp.replace(/\/+$/, '').replace(/\/mcp$/, '');
    systems[name] = {
      name,
      label: SYSTEM_LABELS[name],
      api: (env[`${upper}_API_URL`] ?? defaults[name].api).replace(/\/+$/, ''),
      mcp,
      mcpHealth: `${mcpBase}/health`,
      web: (env[`${upper}_WEB_URL`] ?? defaults[name].web).replace(/\/+$/, ''),
    };
  }
  return {
    port: Number(env.PORT ?? PORTS.simulator.api),
    systems,
    skipBackfill: env.SKIP_BACKFILL === '1' || env.SKIP_BACKFILL === 'true',
  };
}

/** A recent change on main, used to link the fix in the run timeline. */
export interface MainChange {
  title: string;
  sha: string | null;
  web_url: string;
}

/** The slice of each system's client the engine drives (fakeable in tests). */
export interface Systems {
  logs: Pick<LogsClient, 'ingest' | 'raiseAlert' | 'updateAlert' | 'reset'>;
  servicenow: Pick<ServiceNowClient, 'createIncident' | 'reset'>;
  gitlab: Pick<GitlabClient, 'adminMerge' | 'adminCommit' | 'getRawFile' | 'reset'> & {
    /** Best effort: the latest merge (or commit) on main, excluding `excludeSha`. */
    latestMainChange?(project: string, excludeSha?: string): Promise<MainChange | null>;
  };
  teams: Pick<TeamsClient, 'reset'>;
}

export function createSystems(config: SimulatorConfig): Systems {
  const gitlab = createGitlabClient(config.systems.gitlab.api);
  return {
    logs: createLogsClient(config.systems.logs.api),
    servicenow: createServiceNowClient(config.systems.servicenow.api),
    gitlab: {
      adminMerge: gitlab.adminMerge,
      adminCommit: gitlab.adminCommit,
      getRawFile: gitlab.getRawFile,
      reset: gitlab.reset,
      latestMainChange: (project, excludeSha) => latestMainChange(gitlab, project, excludeSha),
    },
    teams: createTeamsClient(config.systems.teams.api),
  };
}

/**
 * The newest merged MR on main (else the newest commit) other than `excludeSha`, via the typed
 * GitLab list endpoints. Failures return null: the timeline just omits the link.
 */
async function latestMainChange(
  gitlab: GitlabClient,
  project: string,
  excludeSha?: string,
): Promise<MainChange | null> {
  try {
    const page = await gitlab.listProjectMergeRequests(project, {
      state: 'merged',
      order_by: 'merged_at',
      sort: 'desc',
      limit: 5,
    });
    const mr = page.items
      .filter((m) => m.merge_commit_sha !== excludeSha)
      .sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? ''))[0];
    if (mr) return { title: mr.title, sha: mr.merge_commit_sha, web_url: mr.web_url };
  } catch {
    // fall through to commits
  }
  try {
    const page = await gitlab.listCommits(project, { ref_name: 'main', limit: 1 });
    const c = page.items[0];
    if (c && c.id !== excludeSha) return { title: c.title, sha: c.id, web_url: c.web_url };
  } catch {
    // endpoint unavailable
  }
  return null;
}

/** `GET <url>` with a short timeout. Used for API and MCP health. */
export async function checkHealth(url: string, timeoutMs = 1500): Promise<EndpointHealth> {
  const started = Date.now();
  const checked_at = new Date().toISOString();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      return { url, ok: false, latency_ms, error: `HTTP ${res.status}`, stats: null, checked_at };
    }
    const body = (await res.json().catch(() => null)) as Health | null;
    return { url, ok: true, latency_ms, error: null, stats: body?.stats ?? null, checked_at };
  } catch (err) {
    const error =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'timeout'
        : err instanceof Error
          ? ((err.cause as Error | undefined)?.message ?? err.message)
          : String(err);
    return { url, ok: false, latency_ms: null, error, stats: null, checked_at };
  }
}

export type HealthChecker = (url: string) => Promise<EndpointHealth>;
