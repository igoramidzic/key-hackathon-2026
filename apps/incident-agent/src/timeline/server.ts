/**
 * Live case timeline (#27): a small HTTP server in the agent that shows the demo audience what it
 * is doing and thinking, with a link to every record it touches.
 *
 *   GET /               the page: one self-contained HTML document (no build step)
 *   GET /api/info       how the agent is running (speed, model or deterministic, auto-resolve)
 *   GET /api/cases      case summaries, open cases first
 *   GET /api/cases/:id  one full case (by id or incident number)
 *   GET /api/stream     SSE: `snapshot` (every case view), then `case` on each change,
 *                       `removed`, and a `ping` heartbeat
 *
 * Inside the agent it listens to the store. With `fromDisk` it serves cases another process
 * writes (`pnpm agent timeline`), reloading the store every couple of seconds.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { CaseStore } from '../cases/store';
import type { Case } from '../cases/types';
import type { Logger } from '../log';
import { errorMessage, isoNow } from '../util';
import { caseSummary, caseView, defaultWeb, ordered, type WebBases } from './view';

export interface TimelineServerOptions {
  /** 0 picks a free port. */
  port: number;
  log: Logger;
  /** Serve a store another process writes: poll it instead of subscribing. */
  fromDisk?: boolean;
  /** fromDisk poll interval (default 2s). */
  pollMs?: number;
  /** SSE heartbeat interval (default 15s). */
  heartbeatMs?: number;
  /** UI bases of the four systems (default: @sim/contracts URLS, which honor SIM_PUBLIC_URL). */
  web?: WebBases;
  /** Interface to bind (default: all). */
  host?: string;
  /** Served at /api/info, so the guided demo can match the scenario speed to the agent's. */
  info?: TimelineInfo;
}

export interface TimelineInfo {
  speed: number;
  llm: string;
  auto_resolve: boolean;
  dry_run: boolean;
}

export interface TimelineServer {
  url: string;
  close(): Promise<void>;
}

/** Changes are batched this long, so a burst of tool calls is one update. */
const COALESCE_MS = 150;

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const UI_THEME = here('../../../../packages/ui/src/theme.css');
const FONTS: Record<string, { family: string; file: string }> = {
  geist: {
    family: 'Geist Variable',
    file: '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
  },
  'geist-mono': {
    family: 'Geist Mono Variable',
    file: '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2',
  },
};

/** Used only if @sim/ui's theme can't be read: its light tokens, the ones the page uses. */
const FALLBACK_TOKENS = `:root {
  --background: oklch(0.982 0 0); --foreground: oklch(0.205 0 0); --card: oklch(1 0 0);
  --primary: oklch(0.205 0 0); --primary-foreground: oklch(0.985 0 0); --muted: oklch(0.955 0 0);
  --muted-foreground: oklch(0.5 0 0); --border: oklch(0.91 0 0);
  --positive: oklch(0.5 0.11 152); --negative: oklch(0.52 0.16 27); --warning: oklch(0.55 0.12 70);
  --chart-1: oklch(0.52 0.12 255); --chart-4: oklch(0.53 0.12 300); --chart-7: oklch(0.66 0.11 228);
}`;

const SYSTEM_LINKS: [keyof WebBases, string][] = [
  ['logs', 'Cloud Logging'],
  ['servicenow', 'ServiceNow'],
  ['gitlab', 'GitLab'],
  ['teams', 'Microsoft Teams'],
];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

interface Assets {
  html: string;
  fonts: Map<string, Buffer>;
}

/** The page, with @sim/ui's theme tokens and Geist fonts when the workspace has them. */
function loadAssets(log: Logger, web: WebBases): Assets {
  const fonts = new Map<string, Buffer>();
  let tokens = FALLBACK_TOKENS;
  try {
    const theme = readFileSync(UI_THEME, 'utf8');
    const light = /:root,\s*\.light\s*\{([^}]*)\}/.exec(theme)?.[1];
    if (light) tokens = `:root {${light}}`;
    const require = createRequire(UI_THEME);
    for (const [name, font] of Object.entries(FONTS)) {
      try {
        fonts.set(name, readFileSync(require.resolve(font.file)));
      } catch {
        // system font fallback
      }
    }
  } catch (err) {
    log.warn(`@sim/ui theme not readable (${errorMessage(err)}); using built-in colors`);
  }
  const faces = [...fonts.keys()]
    .map(
      (name) =>
        `@font-face{font-family:"${FONTS[name]!.family}";font-style:normal;font-display:swap;font-weight:100 900;src:url(fonts/${name}.woff2) format("woff2")}`,
    )
    .join('\n');
  const css = readFileSync(here('./page.css'), 'utf8');
  const js = readFileSync(here('./page.js'), 'utf8');
  const systems = SYSTEM_LINKS.filter(([id]) => web[id])
    .map(
      ([id, name]) =>
        `<a href="${escapeHtml(web[id]!)}" target="_blank" rel="noreferrer"><i class="sys sys-${id}"></i>${name}</a>`,
    )
    .join('');
  const icon =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23333'/%3E%3C/svg%3E";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Incident agent: live cases</title>
<link rel="icon" href="${icon}">
<style>
${faces}
${tokens}
${css}
</style>
</head>
<body>
<div class="top">
  <header class="bar">
    <span class="brand"><span class="mark">IA</span>Incident Agent</span>
    <span id="status" class="status tone-warning"><i class="dot"></i>Connecting</span>
  </header>
  <nav class="systems" aria-label="Simulated systems">${systems}</nav>
</div>
<main>
  <div class="intro">
    <h1>What the agent is doing</h1>
    <p>Every case the incident agent is working on: where it is, what it thinks the cause is, and each step it took. Every record links to the system it lives in.</p>
  </div>
  <div id="cases" class="section"></div>
</main>
<script>
${js}
</script>
</body>
</html>
`;
  return { html, fonts };
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  cache = 'no-store',
): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': cache,
    'access-control-allow-origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const json = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) =>
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body));

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function startTimelineServer(
  store: CaseStore,
  opts: TimelineServerOptions,
): Promise<TimelineServer> {
  const { log } = opts;
  const web = opts.web ?? defaultWeb();
  const assets = loadAssets(log, web);
  const clients = new Set<ServerResponse>();
  if (opts.fromDisk) store.load();

  const find = (id: string): Case | undefined =>
    store.get(id) ?? store.all().find((c) => c.incident?.number === id);

  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function broadcast(event: string, data: unknown): void {
    if (clients.size === 0) return;
    const text = frame(event, data);
    for (const res of clients) {
      if (res.destroyed || res.writableEnded) clients.delete(res);
      else res.write(text);
    }
  }

  // Changes are coalesced per case: the latest state is what gets sent.
  const pending = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  function flush(): void {
    flushTimer = undefined;
    const ids = [...pending];
    pending.clear();
    for (const id of ids) {
      const c = store.get(id);
      if (c) broadcast('case', caseView(c, web));
      else broadcast('removed', { id });
    }
  }
  function changed(id: string): void {
    if (clients.size === 0) return;
    pending.add(id);
    flushTimer ??= setTimeout(flush, COALESCE_MS);
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    req.socket.setNoDelay(true);
    res.write('retry: 3000\n\n');
    res.write(
      frame('snapshot', { at: isoNow(), cases: ordered(store.all()).map((c) => caseView(c, web)) }),
    );
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  function route(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(req, res, 405, { error: 'method not allowed' });
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/index.html')
      return send(req, res, 200, 'text/html; charset=utf-8', assets.html);
    if (path === '/api/info') return json(req, res, 200, { ...opts.info, at: isoNow() });
    if (path === '/api/cases')
      return json(req, res, 200, {
        cases: ordered(store.all()).map((c) => caseSummary(c, web)),
      });
    if (path === '/api/stream') return stream(req, res);
    const one = /^\/api\/cases\/([^/]+)$/.exec(path);
    if (one) {
      const id = decode(one[1]!);
      const c = id ? find(id) : undefined;
      return c ? json(req, res, 200, c) : json(req, res, 404, { error: `no case ${id ?? ''}` });
    }
    const font = /^\/fonts\/([\w-]+)\.woff2$/.exec(path);
    const data = font ? assets.fonts.get(font[1]!) : undefined;
    if (data) return send(req, res, 200, 'font/woff2', data, 'public, max-age=86400');
    json(req, res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      log.warn(`${req.method} ${req.url} failed: ${errorMessage(err)}`);
      if (!res.headersSent) json(req, res, 500, { error: errorMessage(err) });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const ready = () => {
      server.off('error', reject);
      resolve();
    };
    if (opts.host) server.listen(opts.port, opts.host, ready);
    else server.listen(opts.port, ready);
  });
  server.on('error', (err) => log.warn(`timeline server: ${errorMessage(err)}`));

  let unsubscribe: (() => void) | undefined;
  let poll: NodeJS.Timeout | undefined;
  if (opts.fromDisk) {
    let known = new Map(store.all().map((c) => [c.id, c.updated_at]));
    poll = setInterval(() => {
      let cases: Case[];
      try {
        cases = store.load();
      } catch (err) {
        log.warn(`could not reload cases: ${errorMessage(err)}`);
        return;
      }
      const next = new Map(cases.map((c) => [c.id, c.updated_at]));
      for (const [id, at] of next) if (known.get(id) !== at) changed(id);
      for (const id of known.keys()) if (!next.has(id)) changed(id);
      known = next;
    }, opts.pollMs ?? 2_000);
  } else {
    unsubscribe = store.subscribe((c) => changed(c.id));
  }
  const heartbeat = setInterval(
    () => broadcast('ping', { at: isoNow() }),
    opts.heartbeatMs ?? 15_000,
  );

  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  log.info(`live timeline on ${url}${opts.fromDisk ? ` (reading ${store.casesDir})` : ''}`);

  return {
    url,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(poll);
      clearTimeout(flushTimer);
      unsubscribe?.();
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
