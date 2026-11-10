# Incident Response Sim

A simulated bank IT estate for an automated incident-resolution agent. Errors show up in logs,
rules detect them, and an agent traces the root cause, opens a ServiceNow incident, starts a Teams
channel with the right support people, and opens a fix MR in GitLab.

This repo is the **simulated world**: four mock systems with seeded data, a UI, a REST API and an
MCP server each, plus a scenario engine that runs background traffic and triggers incidents. The
agent, detection rules, log ingestion and ownership logic are built separately and plug in through
the MCP servers and the live log stream.

## Quick start

Requires Node 22+ and pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

That starts all 14 processes. Open the control panel at <http://localhost:3000>, pick a scenario
and click **Trigger**. Within about 30 seconds errors start cascading through the logs.

## What's running

| System | UI | REST API | MCP (Streamable HTTP) |
| --- | --- | --- | --- |
| Control panel and simulator | [localhost:3000](http://localhost:3000) | `:4000` | – |
| Logs: Cloud Logging and Moogsoft alerts | [localhost:3001](http://localhost:3001) | `:4001` | `http://localhost:5001/mcp` |
| ServiceNow | [localhost:3002](http://localhost:3002) | `:4002` | `http://localhost:5002/mcp` |
| GitLab | [localhost:3003](http://localhost:3003) | `:4003` | `http://localhost:5003/mcp` |
| Teams | [localhost:3004](http://localhost:3004) | `:4004` | `http://localhost:5004/mcp` |

Each system has one REST API, which both its UI and its MCP server use. All state is in memory
and seeded from a fixed seed, so every run starts from the same data. Restarting a service, or
**Reset** in the control panel, restores the baseline.

- **Logs** (`:3001`): Logs Explorer with the GCP query language, a severity histogram, expandable
  entries with stack traces and live streaming. Moogsoft alerts live under **Alerts**.
- **ServiceNow** (`:3002`): incidents with the activity stream, the app catalog (TLA, tier, owner,
  support group, on-call, upstream and downstream apps), support groups and people.
- **GitLab** (`:3003`): `keybank/<TLA>00/<repo>` groups and projects, code, commits, MRs with
  diffs, green pipelines, and a **Merge** button for humans.
- **Teams** (`:3004`): teams, channels, members with the reason they were added, messages, and an
  Activity feed per person. Use **Viewing as** to see someone's notifications.

## Scenarios

Each scenario merges a real bad MR into a hero app, then plays out the consequences: errors in the
logs of the affected apps, Moogsoft alerts and, for one scenario, a call to the help desk. Two
unrelated red-herring merges land nearby. Background traffic and unrelated commits keep flowing
the whole time.

| ID | Kind | What operators see |
| --- | --- | --- |
| `cif-snake-case-cascade` | Multi-app cascade (headline demo) | Online and mobile banking stop loading customer profiles, payments fail payer verification, and errors spread to every system that reads customer data (9 hero apps plus 27 more). |
| `ath-token-ttl-cascade` | Multi-app cascade | Customers get logged out of online and mobile banking, tellers lose sessions, and services across the estate reject requests as unauthorized. |
| `aba-checksum-cascade` | Multi-app cascade | ACH batches are held, wires are rejected and customers can't add bill payees, all citing routing numbers that look perfectly valid. |
| `crd-pool-exhaustion` | Single app | Card lock/unlock and card controls fail in the mobile app; the card management API answers slowly with errors. |
| `tlr-business-date-helpdesk` | Help-desk call | A branch manager calls the service desk: teller receipts show tomorrow's date and drawers won't balance. Logs only show warnings, so the incident starts from the call, not from monitoring. |

In the cascades the culprit service stays green: it keeps returning 200s and its MR had a passing
pipeline. The agent has to work back from the failing apps through the dependency graph
(ServiceNow) to the upstream app's recent MRs (GitLab).

When a fix lands on the culprit's `main` branch (an agent's MR merged by a human in the GitLab
UI, or any equivalent change), the simulator detects it within about 5 seconds. It then logs a
deploy, ramps the errors down and resolves the scenario's alerts. Every scenario ships with a
known-correct fix, so you can check an agent's MR against it.

<details>
<summary>Answer key (spoilers)</summary>

| Scenario | Culprit | Bad change | Known fix |
| --- | --- | --- | --- |
| `cif-snake-case-cascade` | CIF `keybank/CIF00/customer-profile-api` | "Adopt enterprise API naming standard": Jackson `property-naming-strategy` goes from `LOWER_CAMEL_CASE` to `SNAKE_CASE`, and the controller test and fixture are rewritten so CI stays green. Consumers can't find `customerId`. | Restore camelCase. |
| `ath-token-ttl-cascade` | ATH `keybank/ATH00/auth-token-service` | "Move token TTL to unified config loader": the new YAML config is in minutes, but the access-token TTL is used as seconds, so tokens expire after 15 s. ATH's own logs show `expires_in=15`. | Multiply by 60. |
| `aba-checksum-cascade` | ABA `keybank/ABA00/routing-directory-service` | "Optimize ABA checksum validation": the unrolled checksum uses the wrong weights, so most valid routing numbers fail. ABA returns 200 `{valid:false}`. | Restore the 3-7-1 weights. |
| `crd-pool-exhaustion` | CRD `keybank/CRD00/card-management-api` | "Right-size Hikari pool per DBA review": pool size 40 → 5, timeout 10 s → 2 s. | Restore 40 and 10000 ms. |
| `tlr-business-date-helpdesk` | TLR `keybank/TLR00/teller-workstation-api` | "Use UTC consistently": the business-day timezone also becomes UTC, so afternoon transactions post to tomorrow. | Restore `America/New_York`. |

The control panel shows the same answer key, with diffs, behind **Reveal answer key**.

</details>

### Triggering

- **Control panel** (<http://localhost:3000>): Trigger, Stop, Reset, speed (1x to 10x), a live
  timeline of the run, links to the bad MR and alerts, and the answer key.
- **CLI**:

  ```bash
  pnpm sim list
  ```

  ```bash
  pnpm sim trigger cif-snake-case-cascade --speed 2
  ```

  ```bash
  pnpm sim status
  ```

  ```bash
  pnpm sim reset
  ```

  Also `pnpm sim stop` and `pnpm sim traffic --pause|--resume|--rate N`.
- **REST** on `:4000`: `GET /api/scenarios`, `POST /api/scenarios/:id/trigger {speed?, force?}`,
  `POST /api/stop`, `POST /api/reset`, `GET /api/status`.

Only one scenario runs at a time. Reset between runs so each one starts from the baseline.

## Connecting the agent

Building the agent? Start with [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md): connection snippets
for Claude Code, the Claude Agent SDK, Google ADK and raw MCP, the expected incident workflow
step by step, the trigger/reset/verify dev loop, and troubleshooting. Coding agents get their
orientation from [AGENTS.md](AGENTS.md) (`CLAUDE.md` imports it).

### MCP servers

Four servers with 44 tools. Every tool has a typed input schema and a description of when to use
it; lists are paginated with `limit` and `cursor`; there are no delete tools. Writes default to
the bot identity `svc_incident_auto` ("Incident Automation") unless you pass an author.

Claude Code:

```bash
claude mcp add --transport http sim-logs http://localhost:5001/mcp
```

```bash
claude mcp add --transport http sim-servicenow http://localhost:5002/mcp
```

```bash
claude mcp add --transport http sim-gitlab http://localhost:5003/mcp
```

```bash
claude mcp add --transport http sim-teams http://localhost:5004/mcp
```

This repo already ships a `.mcp.json` with the four local servers, so Claude Code sessions opened
here pick them up. Elsewhere, a project `.mcp.json` looks like:

```json
{
  "mcpServers": {
    "logs": { "type": "http", "url": "http://localhost:5001/mcp" },
    "servicenow": { "type": "http", "url": "http://localhost:5002/mcp" },
    "gitlab": { "type": "http", "url": "http://localhost:5003/mcp" },
    "teams": { "type": "http", "url": "http://localhost:5004/mcp" }
  }
}
```

Google ADK (Python):

```python
from google.adk.tools.mcp_tool import MCPToolset, StreamableHTTPConnectionParams

toolsets = [
    MCPToolset(connection_params=StreamableHTTPConnectionParams(url=f"http://localhost:{port}/mcp"))
    for port in (5001, 5002, 5003, 5004)
]
```

Clients that only speak stdio can launch a server directly. The REST APIs still need to be
running (`pnpm dev`):

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/repo", "--filter", "@sim/gitlab-mcp", "stdio"]
    }
  }
}
```

Hosted model APIs whose MCP connector calls the server from the provider's cloud can't reach
`localhost`. Run the agent locally, or expose the MCP ports through a tunnel.

### Tools

| Server | Tools |
| --- | --- |
| **logs** | `search_logs`, `get_log_entry`, `tail_logs` (long-poll with a cursor), `summarize_errors` (error fingerprints per app with counts and first and last seen), `get_log_histogram`, `list_log_services`, `list_alerts`, `get_alert`, `update_alert` |
| **servicenow** | `list_incidents`, `get_incident`, `create_incident`, `update_incident` (fields, work note, links and resolve in one call), `add_incident_note`, `search_apps`, `get_app` (owner, support group, on-call, dependencies), `get_app_dependencies` (graph walk up or down), `search_support_groups`, `get_support_group`, `search_users`, `get_user` |
| **gitlab** | `search_projects`, `get_project`, `list_recent_commits` (by project or a whole TLA), `get_commit`, `compare_refs` (accepts `main~2`, `HEAD^`), `list_merge_requests`, `get_merge_request` (diffs, pipeline, approvals), `get_file_tree`, `get_file`, `fetch_repository` (every file plus a tarball URL, i.e. "clone"), `create_merge_request` (branch, commit and MR in one call; full-content or find/replace edits), `update_merge_request` (labels), `add_merge_request_note`, `create_tag` |
| **teams** | `list_teams`, `list_channels`, `get_channel`, `create_channel` (with initial members and reasons), `add_channel_members`, `remove_channel_member`, `post_message`, `read_messages`, `list_notifications` |

There is deliberately no merge tool: a human merges the fix MR in the GitLab UI. The REST call is
`PUT :4003/api/v4/projects/:id/merge_requests/:iid/merge` if you want to automate it.

Adding someone to a channel with a reason sends them an Activity notification like: *"You've been
added to #inc0010204-customer-profile-errors as support for CIF - Customer Information File.
Here's who else is in the channel: Dana Whitfield (NOC shift lead, incident commander), …"*

### Live log stream (for rule-based detection)

Server-Sent Events of every new log entry, in arrival order. Each event's `id` is a monotonic
`seq`, so reconnecting with `Last-Event-ID` (or `?after_seq=`) resumes without gaps. Heartbeats go
out every 15 s.

```bash
curl -N "http://localhost:4001/api/logs/stream?severity=WARNING"
```

Filters: `filter` (query language below), `severity` (minimum), `app_tla`, `service` and `q`, all
optional. To poll instead, call `GET /api/logs/tail?after_seq=<seq>&wait_seconds=30` (long-poll).

Entries use the GCP `LogEntry` shape: `severity`, `timestamp`, `labels.app_tla` (the ServiceNow
TLA), `resource.labels.container_name` (the service), `jsonPayload.message`,
`jsonPayload.error.{type,message,stack_trace}`, `httpRequest.status`, `trace`. The query language
is a practical subset of Logs Explorer:

```
severity>=ERROR AND labels.app_tla=("OLB" OR "MBL") AND jsonPayload.message:"customerId"
resource.labels.container_name="payments-api" httpRequest.status>=500 -"client disconnected"
```

Moogsoft alerts are at `GET /api/alerts` and through the `list_alerts` tool.

## The seeded world

Everything derives from one deterministic world (`packages/world`, seed 2026):

- **400 apps**, each with a TLA, name, tier, criticality, business unit, owner, support group and
  developers. Each app has upstream and downstream dependencies. 15 hand-written core banking apps
  anchor the scenarios: ATH, CIF, DEP, GLD, NTF, FRD, ABA, ACH, WIR, PAY, BPY, CRD, TLR, OLB, MBL.
  60 apps emit live log traffic.
- **1,199 people.** The username is the same key in ServiceNow, GitLab and Teams. Recurring
  personas: `dwhitfield` (NOC shift lead), `mbell` (NOC), `pnatarajan` (service desk), `tokafor`
  (major incident manager) and `mlopez` (branch manager). `svc_incident_auto` is the agent's bot
  account.
- **51 support groups**, each with members, a manager and on-call primary and secondary. They
  include the NOC, the service desk, major incident management and infrastructure teams.
- **776 GitLab projects** with realistic code per stack (Spring Boot, Node/TypeScript, Python,
  React and Terraform), about 21k commits and 5.6k MRs of history. The hero repos have
  hand-written code, and their stack traces point at real lines.
- **ServiceNow** holds 203 historical incidents (none open on hero apps).
- **Teams** starts quiet: one Incident Response team with a General channel. Incident channels
  appear only when the agent (or a person) creates them.
- **Logs** are backfilled with 20 minutes of traffic at startup (about 22 lines/s), and
  background alerts and unrelated merges keep arriving.

## Hosting on Cloudflare (one Worker, one domain)

The same code also runs as a single Cloudflare Worker. Every system lives under a path on one
origin:

| Path | What |
| --- | --- |
| `/` | Control panel |
| `/api/*` | Simulator API (what `pnpm sim` and the control panel call) |
| `/logs/`, `/servicenow/`, `/gitlab/`, `/teams/` | Each system's UI |
| `/<system>/api/...` | That system's REST API (e.g. `/gitlab/api/v4/projects`, `/logs/api/logs/stream`) |
| `/<system>/mcp` | That system's MCP server (Streamable HTTP) |

```
browser / agent ──► Worker ─┬─► static assets (5 UIs, SPA fallback per prefix)
                            └─► Durable Object "SimWorld" (one instance)
                                  ├─ logs, servicenow, gitlab, teams REST APIs
                                  ├─ 4 MCP servers
                                  └─ simulator engine (traffic, scenarios, fix detection)
```

- **One Durable Object holds the whole estate in memory.** Every client sees one consistent
  world. Calls between systems (simulator → APIs, MCP → REST) are dispatched in process, so
  there are no network hops.
- **Heartbeat and idle shutdown.** An alarm every 5 seconds keeps the simulator's timers running
  while the world is in use. After 30 minutes with no requests it winds down, and the next visit
  rebuilds the world from the seed, the same as **Reset**.
- **Memory sizing.** A Durable Object gets 128 MB, so the Worker runs a lighter estate:
  - 15k log lines at 0.75× traffic, which keeps about 18 minutes of history.
  - 30% of the generated GitLab history. Hero repos keep their full history.
  - A 40-repo cache of rendered GitLab code.

  Measured heap is about 63 MB after boot and about 74 MB in the worst case. The knobs are `vars`
  in `apps/cloudflare/wrangler.jsonc`.

Run it locally under the real Workers runtime (builds the UIs, then serves on :8787):

```bash
pnpm worker:dev
```

**Live:** <https://hackathon-incident-lab.kualia.workers.dev>. MCP servers are at
`https://hackathon-incident-lab.kualia.workers.dev/<logs|servicenow|gitlab|teams>/mcp`.

**Deploys:** every merge to `main` deploys automatically (`.github/workflows/deploy.yml`). The
workflow runs lint, typecheck and tests, builds the UIs, runs `wrangler deploy`, and then
smoke-tests the live site. Pull requests run the checks only. It needs one repo secret,
`CLOUDFLARE_API_TOKEN`: in the Cloudflare dashboard go to *My Profile → API Tokens → Create
Token* and use the *Edit Cloudflare Workers* template. Then store it:

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

To deploy by hand (needs `npx wrangler login` once):

```bash
pnpm worker:deploy
```

To point the CLI or the e2e test at it, set `SIM_PUBLIC_URL`:

```bash
SIM_PUBLIC_URL=http://localhost:8787 pnpm e2e
```

```bash
SIM_PUBLIC_URL=https://hackathon-incident-lab.kualia.workers.dev pnpm sim status
```

## Testing

```bash
pnpm e2e
```

This runs against the live stack (`pnpm dev` first). It checks that every service answers and
that every MCP tool has a well-formed contract. It then drives the headline scenario the way an
agent would, calling all 44 tools: it traces the cascade to CIF, opens an incident and a Teams
channel, and opens a fix MR. A human-style merge follows, and the run must recover. Finally it runs
every other scenario, checking symptoms, a green culprit, alerts or the help-desk incident, and
recovery. Options:

- `--scenario <id>`: run one scenario.
- `--speed N`: run scenarios at N times speed (default 6).
- `--skip-scenarios`: services and MCP contracts only.
- `--keep`: leave the finished run's incident, channel and MRs in place to look at.

Other checks:

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

## Repo layout

```
packages/world        deterministic world: apps, TLAs, dependencies, people, groups, repos
packages/contracts    ports/URLs and a typed REST client per system (used by UIs, MCP servers, simulator)
packages/scenarios    scenario definitions and the hero apps' hand-written code
packages/api-kit      Hono helpers for the REST APIs
packages/mcp-kit      MCP server bootstrap and tool helpers
packages/ui           shared React components
systems/<name>/api    REST API (owns the system's state)
systems/<name>/mcp    MCP server (calls the REST API)
systems/<name>/web    UI (calls the REST API)
apps/simulator        traffic generator, scenario engine, fix detector, CLI
apps/control-panel    control panel UI
apps/cloudflare       single-Worker host: path router, Durable Object, UI build
scripts/e2e.ts        end-to-end test
```

Stack: TypeScript, pnpm and Turborepo, Biome, Hono, the MCP TypeScript SDK, React, Vite,
Tailwind, Faker (fixed seed; names are snapshotted at build time, `pnpm --filter @sim/world gen:names`) and Cloudflare Workers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for conventions:
REST shapes, web URL formats and MCP guidelines.
