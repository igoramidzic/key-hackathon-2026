# Architecture

Conventions for changing the simulated world. To build the agent that uses it, see
[AGENT-GUIDE.md](AGENT-GUIDE.md).

A simulated bank IT estate for an automated incident-resolution agent. Four mock systems
(Logs + Moogsoft, ServiceNow, GitLab, Teams), each with one REST API, a web UI and an MCP server,
plus a simulator that runs background traffic and triggers incident scenarios.

```
                      ┌────────────────────────────── simulator (4000) ─────────────────────────────┐
                      │ traffic generator · scenario engine · KBR releases · noise commits · CLI   │
                      └───────┬──────────────────┬──────────────────┬──────────────────┬────────────┘
                              │ ingest/alerts    │ incidents         │ admin merges     │ reset
                              ▼                  ▼                   ▼                  ▼
  REST APIs            logs-api (4001)    servicenow-api (4002)  gitlab-api (4003)  teams-api (4004)
                         ▲      ▲            ▲       ▲             ▲      ▲           ▲      ▲
  UIs (Vite)       logs-web 3001 │     sn-web 3002 │      gitlab-web 3003│    teams-web 3004 │
  MCP (HTTP)            logs-mcp 5001       sn-mcp 5002         gitlab-mcp 5003      teams-mcp 5004
                                  ▲                ▲                     ▲                    ▲
                                  └──── the agent (apps/incident-agent) ──┴────────────────────┘
```

## Layout

| Path                 | Package              | What                                                                                                            |
| -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/world`     | `@sim/world`         | Deterministic world: people, apps (TLA catalog + dependency graph), support groups, repos. Seed 2026.           |
| `packages/contracts` | `@sim/contracts`     | Ports/URLs, `createHttp`, shared types, and one typed REST client per system (`@sim/contracts/<system>`).       |
| `packages/api-kit`   | `@sim/api-kit`       | Hono helpers: `createApi`, `startApi`, `HttpError`, `parseBody`, `parseQuery`, `paginate`, `parseTime`.         |
| `packages/mcp-kit`   | `@sim/mcp-kit`       | MCP bootstrap (`serveMcpHttp`, `serveMcpStdio`), `defineTool`, annotation presets, `paginationShape`.           |
| `packages/ui`        | `@sim/ui`            | React components (Button, Badge, Card, Table, Tabs, CodeBlock, JsonView, Avatar, RelativeTime, …) and base CSS. |
| `packages/scenarios` | `@sim/scenarios`     | Scenario definitions and hero repo code overlays.                                                               |
| `systems/<name>/api` | `@sim/<name>-api`    | The system's REST API. Owns all of the system's state (in memory).                                              |
| `systems/<name>/mcp` | `@sim/<name>-mcp`    | MCP server. Talks to the REST API through `@sim/contracts/<name>`. Never imports API code.                      |
| `systems/<name>/web` | `@sim/<name>-web`    | Vite + React UI. Talks to the REST API through `@sim/contracts/<name>` via the Vite proxy.                      |
| `apps/simulator`     | `@sim/simulator`     | Scenario engine + traffic generator (REST on 4000) and CLI.                                                     |
| `apps/control-panel` | `@sim/control-panel` | Control panel UI (3000).                                                                                        |
| `apps/incident-agent` | `@sim/incident-agent` | The incident agent (not part of `pnpm dev`): watches the world over MCP and the live feeds. See its README.        |

## Ports

| System                          | UI   | REST API | MCP (Streamable HTTP) |
| ------------------------------- | ---- | -------- | --------------------- |
| Simulator / control panel       | 3000 | 4000     | –                     |
| Logs (Cloud Logging + Moogsoft) | 3001 | 4001     | 5001 `/mcp`           |
| ServiceNow                      | 3002 | 4002     | 5002 `/mcp`           |
| GitLab                          | 3003 | 4003     | 5003 `/mcp`           |
| Teams                           | 3004 | 4004     | 5004 `/mcp`           |

Defined once in `packages/contracts/src/config.ts` (`PORTS`, `URLS`). Vite configs hardcode their
API port because they can't import TS packages.

## The shared world (`@sim/world`)

`getWorld()` returns the same data in every process:

- **people** (~1,200): `username` is the cross-system key (ServiceNow user = GitLab user = Teams
  user). Emails are `first.last@keybank.example`. Roles: engineer, support, manager, infra, noc,
  service_desk, incident_manager, branch, executive, bot.
- **personas** (`PERSONAS`): `svc_incident_auto` (Incident Automation, the agent's identity),
  `dwhitfield` (NOC shift lead), `mbell` (NOC), `pnatarajan` (service desk), `tokafor` (major
  incident manager), `mlopez` (branch manager, Cleveland Main), `kbrandt` (head teller).
- **apps** (400): TLA, name, tier, criticality, business unit, owner, support group, developers,
  `upstream` (what it calls) and `downstream` (who calls it), repo paths, runtime (service name,
  GCP project, namespace, cluster). 15 **hero apps** are hand-written core banking systems used by
  scenarios: ATH, GLD, CIF, DEP, NTF, FRD, ABA, ACH, WIR, PAY, BPY, CRD, TLR, OLB, MBL. 60 apps
  (`emitsLogs`) produce live log traffic.
- **support groups** (~50): shared groups (`SHARED_GROUP_IDS`: NOC, Service Desk, Major Incident
  Management, DBA, Network, Cloud, Middleware, SecOps) plus app support groups with members,
  manager and on-call (primary/secondary).
- **repos** (~780): `keybank/<TLA>00/<repo>`, numeric ids from 1001, kind service/web/batch/infra,
  stack java-spring/node-ts/python/react-web/terraform.

Anything random must be deterministic: use `new Rng('<stable key>')` from `@sim/world` (or faker
seeded from a stable key). Timestamps are relative to process start / last reset.

## Promotion to production (KBR)

Nothing reaches production by merging. `main` is QV; ServiceNow change requests (`changes.ts` in
servicenow-api) list merged MRs of one app and a planned start. The simulator's `Kbr`
(`apps/simulator/src/kbr.ts`) polls every 3 s for scheduled changes that are due, validates the MRs
against GitLab, deploys through the estate (rollout lines carry `change_number`/`release_id`), tags
`kbr-<CHG>`, notes the MRs and closes the change through `POST /admin/change_requests/:n/release`.
Scenario runs promote the bad MR the same way and recover only when KBR promotes a commit of the
culprit project that passes `fix.isFixed` (`ScenarioRun.onPromoted`). Change history is imported
from GitLab's merged MRs after every reset (`backfillChangeHistory`).

## REST conventions (all systems)

- JSON keys are `snake_case` (log entries keep GCP's camelCase `LogEntry` shape).
- Lists take `limit` + `cursor` and return `Page<T>` = `{ items, next_cursor, total? }`.
- Errors: `{ "error": "message" }` with 4xx/5xx. Use `HttpError`/`badRequest`/`notFound` from api-kit.
- `GET /health` (from `createApi`, pass `stats` for counters) and `POST /admin/reset` (restore the
  seeded baseline, discarding everything created since) on every API. Other `/admin/*` routes are
  for the simulator only and are not exposed via MCP.
- Entities carry a `web_url` pointing at the system's UI, so links can be pasted anywhere.
- State lives in memory. Restarting or resetting restores the seed.

### Web URL formats (for cross-links)

| System     | Entity   | URL                                                        |
| ---------- | -------- | ---------------------------------------------------------- |
| Logs       | query    | `http://localhost:3001/logs?query=<urlencoded filter>`     |
| Logs       | alert    | `http://localhost:3001/alerts/<id>`                        |
| ServiceNow | incident | `http://localhost:3002/incidents/<INC number>`             |
| ServiceNow | change   | `http://localhost:3002/change_requests/<CHG number>`       |
| ServiceNow | problem  | `http://localhost:3002/problems/<PRB number>` (agenda: `/problems/standup`) |
| ServiceNow | communication | `http://localhost:3002/communications/<CIC number>`   |
| ServiceNow | app      | `http://localhost:3002/apps/<TLA>`                         |
| ServiceNow | group    | `http://localhost:3002/groups/<group id>`                  |
| ServiceNow | user     | `http://localhost:3002/users/<username>`                   |
| GitLab     | group    | `http://localhost:3003/keybank/<TLA>00`                    |
| GitLab     | project  | `http://localhost:3003/keybank/<TLA>00/<repo>`             |
| GitLab     | MR       | `…/<repo>/-/merge_requests/<iid>`                          |
| GitLab     | commit   | `…/<repo>/-/commit/<sha>`                                  |
| GitLab     | file     | `…/<repo>/-/blob/<ref>/<path>` and `…/-/tree/<ref>/<path>` |
| Teams      | channel  | `http://localhost:3004/channels/<channel id>`              |
| Teams      | activity | `http://localhost:3004/activity?user=<username>`           |

## MCP conventions

- One server per system, Streamable HTTP at `http://localhost:500x/mcp` (stateless, JSON responses)
  and stdio via `pnpm --filter @sim/<name>-mcp stdio`.
- `src/server.ts` exports the `McpServerSpec`; `src/http.ts` and `src/stdio.ts` are entry points.
- Register tools with `defineTool(server, name, { title, description, input, annotations, run })`.
  - Names: `snake_case`, verb first, unique across all four servers (`search_logs`,
    `get_incident`, `list_merge_requests`, `post_message`).
  - Inputs: zod raw shapes, every field `.describe()`d with format and examples.
  - Descriptions say what the tool does, when to use it, and what it returns.
  - Lists use `paginationShape` (`limit`, `cursor`) and return `next_cursor`.
  - Annotations: `READ_ONLY` for reads, `WRITE`/`IDEMPOTENT_WRITE` for writes. **No delete tools.**
  - Return compact, agent-friendly JSON (trim noisy fields in lists; full detail in `get_*`).
- The MCP server calls the REST API through the typed client in `@sim/contracts/<name>`; the base URL
  comes from `<NAME>_API_URL` or `URLS.<name>.api`.

## Web conventions

- React 19, react-router 8 (`BrowserRouter`, `Routes`, `Route`, `Link`, `useParams`,
  `useSearchParams`), TanStack Query (`QueryProvider` from `@sim/ui`), Tailwind v4, lucide icons.
- Fetch through `create<Name>Client('')` (same origin, Vite proxies `/api`, `/admin`, `/health`).
- Brand color via Tailwind theme tokens `brand`, `brand-strong`, `brand-soft`, `brand-fg`.
- Less is more: show what an operator needs for the demo, nothing else. Poll every 2–5s where live
  updates matter (logs stream via SSE).

## Tooling

- `pnpm dev` starts everything (turbo, 14 persistent tasks).
- `pnpm typecheck`, `pnpm lint` (Biome), `pnpm format`, `pnpm test` (vitest where useful).
- TypeScript 7, strict, `verbatimModuleSyntax` (use `import type`). Packages export TS source; no build step for dev.

## Hosting modes

Every API and MCP server is a host-agnostic Hono app factory (`createLogsApp`, `createGitlabApp`,
`createMcpHttpApp(spec)`, `createSimulator()`…). Node-only bootstrapping lives in
`@sim/api-kit/node` and `@sim/mcp-kit/node`.

- **Multi-port (local dev)**: `pnpm dev`. Each app gets its own port (table above).
- **Single origin (Cloudflare)**: `apps/cloudflare`. One Worker serves the built UIs and
  forwards API/MCP paths to one Durable Object that hosts every app, routed by path prefix
  (`/<system>/...`, simulator at the root). `configureUrls(pathUrls(origin))` switches `URLS`, so
  `web_url`s and cross-links use the public origin. Browsers detect single-origin hosting
  themselves, and Node tools opt in with `SIM_PUBLIC_URL`.

Rules that keep both modes working:
- Read `URLS.x.y` at call time; never copy it into a module-level constant.
- Do no work at module import (no seeding, no timers). Workers freeze the clock and forbid timers in
  global scope, so stores build lazily on first use.
- UIs use `import.meta.env.BASE_URL` for the router basename and API client base.
