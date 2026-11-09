import { configureUrls, PORTS, pathUrls, SYSTEMS, type SystemName } from '@sim/contracts';
import { createGitlabApp } from '@sim/gitlab-api/app';
import { spec as gitlabMcp } from '@sim/gitlab-mcp/server';
import { createLogsApp } from '@sim/logs-api/app';
import { spec as logsMcp } from '@sim/logs-mcp/server';
import { createMcpHttpApp } from '@sim/mcp-kit';
import { buildApp as createServiceNowApp } from '@sim/servicenow-api/app';
import { spec as servicenowMcp } from '@sim/servicenow-mcp/server';
import { createSimulator } from '@sim/simulator/host';
import { createTeamsApp } from '@sim/teams-api/app';
import { spec as teamsMcp } from '@sim/teams-mcp/server';

type FetchHandler = (req: Request) => Response | Promise<Response>;

export interface EstateOptions {
  /** Public origin, e.g. https://incident-sim.example.workers.dev. Every web_url is built on it. */
  origin: string;
  /** Log ring-buffer size. Keep it modest on Workers (128 MB per isolate). */
  logsCapacity: number;
  /** Minutes of history the simulator backfills on boot. */
  backfillMinutes: number;
  /** GitLab seeded history scale for generated repos (hero repos keep full history). */
  gitlabHistoryScale: number;
  /** GitLab repos kept rendered in memory (LRU). */
  gitlabMaxMaterializedRepos: number;
  /** Baseline log traffic multiplier (1 ≈ 22 lines/sec). */
  trafficRate: number;
}

/**
 * The whole simulated estate in one process: the four system REST APIs, their MCP servers and the
 * simulator engine, routed by path on one origin:
 *
 *   /api/*, /health          simulator (control panel API)
 *   /<system>/mcp            that system's MCP server (Streamable HTTP)
 *   /<system>/*              that system's REST API with the prefix stripped (/gitlab/api/v4/...)
 *
 * Service-to-service calls keep going through each REST API (simulator → APIs, MCP → API), but are
 * dispatched in process instead of over the network: `fetch` is wrapped so that requests to this
 * origin, or to the multi-port localhost URLs some modules resolve at import time, go straight to
 * the right handler.
 */
export function createEstate(opts: EstateOptions) {
  const origin = opts.origin.replace(/\/+$/, '');
  // URLS must point at the public origin before any store seeds (web_urls are built from it).
  configureUrls(pathUrls(origin));

  const { app: logsApp } = createLogsApp({ capacity: opts.logsCapacity });
  const { app: servicenowApp } = createServiceNowApp();
  const apis: Record<SystemName, FetchHandler> = {
    logs: logsApp.fetch,
    servicenow: servicenowApp.fetch,
    gitlab: createGitlabApp({
      historyScale: opts.gitlabHistoryScale,
      maxMaterializedRepos: opts.gitlabMaxMaterializedRepos,
    }).fetch,
    teams: createTeamsApp().fetch,
  };
  const mcps: Record<SystemName, FetchHandler> = {
    logs: createMcpHttpApp(logsMcp).fetch,
    servicenow: createMcpHttpApp(servicenowMcp).fetch,
    gitlab: createMcpHttpApp(gitlabMcp).fetch,
    teams: createMcpHttpApp(teamsMcp).fetch,
  };
  const simulator = createSimulator({ env: {}, backfillMinutes: opts.backfillMinutes });
  simulator.engine.setTraffic({ rate_multiplier: opts.trafficRate });

  const withPath = (req: Request, path: string): Request => {
    const url = new URL(req.url);
    url.pathname = path;
    return new Request(url, req);
  };

  /** Routes a request for this origin (API/MCP paths only; static UI assets are served elsewhere). */
  const handle = (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const name of SYSTEMS) {
      const prefix = `/${name}`;
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue;
      const rest = url.pathname.slice(prefix.length) || '/';
      if (rest === '/mcp') return Promise.resolve(mcps[name](withPath(req, '/mcp')));
      return Promise.resolve(apis[name](withPath(req, rest)));
    }
    return Promise.resolve(simulator.app.fetch(req));
  };

  // Multi-port localhost URLs (module-level clients resolve these at import) → in-process handlers.
  const byPort = new Map<string, FetchHandler>([
    [String(PORTS.simulator.api), simulator.app.fetch],
  ]);
  for (const name of SYSTEMS) {
    byPort.set(String(PORTS[name].api), apis[name]);
    byPort.set(String(PORTS[name].mcp), mcps[name]);
  }

  const networkFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === origin) return handle(req);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      const local = byPort.get(url.port);
      if (local) return local(req);
    }
    return networkFetch(req);
  }) as typeof fetch;

  return {
    handle,
    engine: simulator.engine,
    /** Starts the simulator: waits for the systems, backfills logs, starts traffic. */
    boot: () => simulator.engine.boot(),
    shutdown: () => {
      simulator.engine.shutdown();
      globalThis.fetch = networkFetch;
    },
  };
}

export type Estate = ReturnType<typeof createEstate>;

/** True for paths the estate handles; everything else is a static UI asset. */
export function isEstatePath(pathname: string): boolean {
  if (pathname === '/health' || pathname.startsWith('/api/')) return true;
  return SYSTEMS.some(
    (name) =>
      pathname === `/${name}/health` ||
      pathname === `/${name}/mcp` ||
      pathname.startsWith(`/${name}/api/`) ||
      pathname.startsWith(`/${name}/admin/`),
  );
}

/** Which UI a static path belongs to ('' = control panel at the root). */
export function uiPrefixFor(pathname: string): string {
  const name = SYSTEMS.find((n) => pathname === `/${n}` || pathname.startsWith(`/${n}/`));
  return name ? `/${name}` : '';
}
