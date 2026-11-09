/**
 * Ports and URLs for every service. Works in Node and the browser (no `process` access).
 * Node services may override the host with SIM_HOST via `serviceUrls(process.env.SIM_HOST)`.
 */
export const PORTS = {
  simulator: { web: 3000, api: 4000 },
  logs: { web: 3001, api: 4001, mcp: 5001 },
  servicenow: { web: 3002, api: 4002, mcp: 5002 },
  gitlab: { web: 3003, api: 4003, mcp: 5003 },
  teams: { web: 3004, api: 4004, mcp: 5004 },
} as const;

export type SystemName = 'logs' | 'servicenow' | 'gitlab' | 'teams';
export const SYSTEMS: SystemName[] = ['logs', 'servicenow', 'gitlab', 'teams'];

export const SYSTEM_LABELS: Record<SystemName | 'simulator', string> = {
  simulator: 'Simulator',
  logs: 'Cloud Logging & Moogsoft',
  servicenow: 'ServiceNow',
  gitlab: 'GitLab',
  teams: 'Teams',
};

export interface SystemUrls {
  web: string;
  api: string;
  mcp: string;
}

export function serviceUrls(host = 'localhost') {
  const u = (port: number) => `http://${host}:${port}`;
  const sys = (name: SystemName): SystemUrls => ({
    web: u(PORTS[name].web),
    api: u(PORTS[name].api),
    mcp: `${u(PORTS[name].mcp)}/mcp`,
  });
  return {
    simulator: { web: u(PORTS.simulator.web), api: u(PORTS.simulator.api) },
    logs: sys('logs'),
    servicenow: sys('servicenow'),
    gitlab: sys('gitlab'),
    teams: sys('teams'),
  };
}

/**
 * Single-origin hosting (one Cloudflare Worker, or the single-port Node host): every system lives
 * under a path prefix on one origin. The control panel and simulator API sit at the root.
 *
 *   https://sim.example.com/                 control panel     /api/...          simulator API
 *   https://sim.example.com/gitlab/          GitLab UI         /gitlab/api/v4/.. GitLab REST
 *   https://sim.example.com/gitlab/mcp       GitLab MCP        (same for logs, servicenow, teams)
 */
export function pathUrls(origin: string): ReturnType<typeof serviceUrls> {
  const o = origin.replace(/\/+$/, '');
  const sys = (name: SystemName): SystemUrls => ({
    web: `${o}/${name}`,
    api: `${o}/${name}`,
    mcp: `${o}/${name}/mcp`,
  });
  return {
    simulator: { web: o, api: o },
    logs: sys('logs'),
    servicenow: sys('servicenow'),
    gitlab: sys('gitlab'),
    teams: sys('teams'),
  };
}

/** Path prefix of each system under single-origin hosting ('' = the simulator at the root). */
export const PATH_PREFIXES: Record<SystemName | 'simulator', string> = {
  simulator: '',
  logs: '/logs',
  servicenow: '/servicenow',
  gitlab: '/gitlab',
  teams: '/teams',
};

/**
 * URLs for every service: entity `web_url`s, cross-links between UIs and service-to-service calls.
 * Always read fields at call time (`URLS.gitlab.web`), never copy them into module-level
 * constants, because hosts may switch them to single-origin mode with `configureUrls`.
 */
export const URLS = serviceUrls();

/** Switches URLS in place (e.g. `configureUrls(pathUrls('https://sim.example.com'))`). */
export function configureUrls(next: ReturnType<typeof serviceUrls>): void {
  Object.assign(URLS.simulator, next.simulator);
  for (const name of SYSTEMS) Object.assign(URLS[name], next[name]);
}

/** True when URLS point at a single origin with path prefixes. */
export function isSingleOrigin(): boolean {
  return URLS.logs.web.endsWith(PATH_PREFIXES.logs);
}

// Auto-configure:
// - Node: SIM_PUBLIC_URL=https://sim.example.com switches to single-origin URLs (CLI, e2e).
// - Browser: a page not served from one of the multi-port dev UI ports is single-origin hosted.
{
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    location?: { origin: string; port: string };
    document?: unknown;
  };
  const publicUrl = g.process?.env?.SIM_PUBLIC_URL;
  if (publicUrl) {
    configureUrls(pathUrls(publicUrl));
  } else if (g.document && g.location) {
    const devPorts = [PORTS.simulator.web, ...SYSTEMS.map((s) => PORTS[s].web)].map(String);
    if (!devPorts.includes(g.location.port)) configureUrls(pathUrls(g.location.origin));
  }
}
