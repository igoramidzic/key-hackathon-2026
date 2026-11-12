# Building the incident agent

How to build an agent that resolves incidents in the simulated world. The world is in this repo;
the agent can live anywhere (a separate repo, a folder here, a notebook); this repo's own agent is
[apps/incident-agent](../apps/incident-agent/README.md). It needs only:

1. The four **MCP servers** (logs, servicenow, gitlab, teams) for investigation and actions.
2. Optionally the **live log stream** and **ServiceNow activity feed** (SSE or long-poll) if you
   build a detector that watches the world and kicks off the agent.
3. The **simulator API** for your own test harness: trigger, reset, and check recovery. Never
   expose it to the agent, because it serves the answer key.

**Prefer clicking around?** <http://localhost:3000/docs> (or `/docs` on the hosted copy) is the
interactive version of this guide. It shows every tool's schema read live from the servers, has
a **Try it** console per tool with working example arguments, shows each call as curl,
TypeScript and Python, and has a live log stream viewer.

## 1. Get the world running

```bash
pnpm install && pnpm dev
```

Wait until the control panel at <http://localhost:3000> shows the engine as running (about 20 s
while logs backfill). Or use the hosted copy and skip this step:
`https://hackathon-incident-lab.kualia.workers.dev` (MCP at `/<system>/mcp`; it is shared, so
other people's runs may be in it).

## 2. Connect

All four servers speak **Streamable HTTP** (stateless, JSON responses) at `/mcp`. No auth.

| Server | Local | Hosted |
| --- | --- | --- |
| logs | `http://localhost:5001/mcp` | `https://hackathon-incident-lab.kualia.workers.dev/logs/mcp` |
| servicenow | `http://localhost:5002/mcp` | `…/servicenow/mcp` |
| gitlab | `http://localhost:5003/mcp` | `…/gitlab/mcp` |
| teams | `http://localhost:5004/mcp` | `…/teams/mcp` |

**Claude Code** in this repo picks them up from `.mcp.json` (approve them on first use). Elsewhere:

```bash
claude mcp add --transport http sim-logs http://localhost:5001/mcp
```

(and the same for `servicenow` 5002, `gitlab` 5003, `teams` 5004).

**Claude Agent SDK (TypeScript):**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const base = process.env.SIM_MCP_BASE; // unset = local ports
const url = (name: string, port: number) =>
  base ? `${base}/${name}/mcp` : `http://localhost:${port}/mcp`;

for await (const msg of query({
  prompt: 'New Moogsoft alerts are firing. Investigate and run the incident process.',
  options: {
    mcpServers: {
      logs: { type: 'http', url: url('logs', 5001) },
      servicenow: { type: 'http', url: url('servicenow', 5002) },
      gitlab: { type: 'http', url: url('gitlab', 5003) },
      teams: { type: 'http', url: url('teams', 5004) },
    },
    allowedTools: ['mcp__logs', 'mcp__servicenow', 'mcp__gitlab', 'mcp__teams'],
  },
})) console.log(msg);
```

**Google ADK (Python):**

```python
from google.adk.tools.mcp_tool import MCPToolset, StreamableHTTPConnectionParams

toolsets = [
    MCPToolset(connection_params=StreamableHTTPConnectionParams(url=f"http://localhost:{p}/mcp"))
    for p in (5001, 5002, 5003, 5004)
]
```

**Raw MCP SDK (TypeScript)**, as used by `scripts/e2e.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5003/mcp')));
const res = await client.callTool({ name: 'list_merge_requests', arguments: { tla: 'CIF', state: 'merged', merged_after: '2h' } });
```

**stdio-only clients** can launch a server directly (the REST APIs still need `pnpm dev`):
`pnpm --silent --dir /path/to/repo --filter @sim/gitlab-mcp stdio`.

**Hosted model APIs** whose MCP connector runs in the provider's cloud can't reach `localhost`.
Use the hosted URLs, run the agent locally, or tunnel the ports.

Quick sanity check that a server is up:

```bash
curl -s http://localhost:5003/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

Each server also sends MCP `instructions` describing its data model and a suggested workflow;
most clients pass these to the model automatically.

## 3. What the agent is expected to do

The demo story, end to end. `scripts/e2e.ts` (`headline()`) performs every step with real tool
calls, so read it for exact argument shapes.

| Step | Goal | Typical tools |
| --- | --- | --- |
| Detect | Notice something is wrong | `list_alerts` (Moogsoft), `summarize_errors`, or your own rules on the SSE stream. For the help-desk scenario the trigger is a new phone incident: poll `list_incidents` with `active: true` and `opened_after`, and look for `contact_type: "phone"`. |
| Scope | Which apps fail, since when | `summarize_errors`, `get_log_histogram`, `search_logs`, `get_log_entry` (stack traces), `list_log_services` |
| Trace | Find the shared upstream cause | `get_app` and `get_app_dependencies` (direction `upstream`) for the failing TLAs; look for a common upstream app |
| Find the change | What reached production and broke it | `list_change_requests` (`app_tla`, `implemented_after`) shows what KBR promoted and when; `get_change_request` lists its MRs and deployed versions. Then `list_merge_requests` (`tla`, `state: "merged"`, `merged_after`), `get_merge_request` (diff, pipeline, KBR's promotion note), `list_recent_commits`, `compare_refs`, `get_file` |
| Open incident | Record it | `create_incident` (`app_tla` = culprit, impact/urgency, `assignment_group` = the app's support group, `contact_type: "monitoring"`) |
| Group duplicates | One parent for one problem | `list_incidents` (`active`, `contact_type: ["phone","email","chat"]`, `relationship: "standalone"`, `opened_after`), then `link_child_incidents` (or `create_incident` with `child_incidents`). Comments on the parent reach every caller; resolving it resolves them |
| Assemble people | Right people, with reasons | `get_support_group` for on-call primary/secondary, then `create_channel` named `inc<number>-<slug>` with `members: [{user, reason}]`, `add_channel_members`, `post_message` |
| Call and communicate | Get people talking, tell the business | `start_meeting` on the incident channel (recording, transcription and the Facilitator are on by default; members are prompted to join). `draft_incident_communication` (`kind: "new"`) writes the Critical Incident Communication for the distribution group (`GRP_CIM_Tech_P<priority>`). It only drafts: a person reviews and sends it in ServiceNow |
| Fix | Propose the change | `create_merge_request` (branch + commit + MR in one call; `changes` take full content or find/replace edits), `add_merge_request_note` |
| Link up | Cross-reference everything | `update_incident` (`add_links`, `work_note`, `state`), `update_alert` (`incident_number`, `status: "acknowledged"`) |
| Ship | Get the fix to production | After a human merges the MR (QV only), `create_change_request` (`type: "emergency"`, `planned_start: "now"`, `related_incidents`). KBR promotes it within seconds; if the MR isn't merged yet, KBR aborts and the change goes back to `new`: merge, then `update_change_request` with `planned_start: "now"` |
| Verify and close | Confirm recovery once KBR promotes the fix | `get_change_request` (state `closed`, deployments), `tail_logs` / `summarize_errors` until errors stop, then `update_incident` with `state: "resolved"` (this also resolves the grouped calls) |
| Close out | The paperwork the process requires | `update_incident` with the Resolution section (`cause_code`, `caused_by_change`, `resolved_by_change`, `outage_start`, `service_restored_at`, `root_cause`, `client_impact`, `employee_impact`; `affected_cis` lists the other apps hit). `create_problem` (`incidents`, root cause, mitigation plan, action items) puts a problem record on the next 8:00 AM problem stand-up; `update_channel` renames the chat with the problem number; `end_meeting`; `draft_incident_communication` (`kind: "restored"`) writes the all-clear |

Things that make it hard on purpose:

- **The culprit looks healthy.** In cascades the upstream app keeps returning 200s and its MR had
  a green pipeline. Errors appear only in downstream apps.
- **Red herrings.** Two unrelated merges land nearby in each scenario, and background commits and
  alerts never stop.
- **The help-desk scenario has almost no errors**, only warnings. The incidents arrive by phone,
  email and chat from four branches, unassigned to an app, each describing a different symptom
  (one blames the receipt printer). They are one problem.
- **Bankers call during the headline cascade too.** Branch staff report Teller Workstation lookup
  failures while monitoring fires; group them under the agent's incident instead of working them
  one by one.
- **Merged is not deployed.** Merging to `main` only deploys to QV. Production changes go out
  through ServiceNow change requests (CHG) that KBR (KeyBank Release, `svc_kbr`) promotes at their
  planned start: it rolls out the merge commits, tags them `kbr-<CHG>`, notes each MR and closes
  the change. A merge that never got a change request never reached production.
- **No merge tool.** The agent opens the MR; a human clicks **Merge** in the GitLab UI. Then a
  change request (raised by the agent or in the ServiceNow UI) promotes it. KBR polls every few
  seconds, logs a deploy and the errors ramp down.

Identity: every write defaults to `svc_incident_auto` ("Incident Automation"). Usernames are the
same in ServiceNow, GitLab and Teams. Fixed personas worth inviting: `dwhitfield` (NOC shift lead,
incident commander), `tokafor` (major incident manager), `pnatarajan` (service desk).

## 4. The dev loop

```bash
pnpm sim reset
```

```bash
pnpm sim trigger cif-snake-case-cascade --speed 4
```

```bash
pnpm sim status
```

Then run your agent. A run is a success when `pnpm sim status` (or `GET :4000/api/status`) shows
`phase: "recovered"` after you merge the agent's MR in the GitLab UI and a change request
promotes it through KBR. Reset between runs so each
one starts from the seeded baseline.

Scenarios, from easiest to hardest to diagnose: `crd-pool-exhaustion` (single app, the failing
app is the culprit), `tlr-business-date-helpdesk` (phone call, warnings only),
`ath-token-ttl-cascade`, `aba-checksum-cascade`, `cif-snake-case-cascade` (headline demo).

To check an agent's work, compare its incident, channel and MR with the answer key in the control
panel (**Reveal answer key**) or `GET :4000/api/scenarios/:id`. Keep that call in your harness and
out of the agent's tools.

Speed: `--speed` up to 10 compresses the scenario timeline. Errors start within about 30 s at 1x.

## 5. Live log stream (for rule-based detection)

```bash
curl -N "http://localhost:4001/api/logs/stream?severity=WARNING"
```

Server-Sent Events, one per log entry, in order. Each event `id` is a monotonic `seq`; reconnect
with `Last-Event-ID` or `?after_seq=` to resume without gaps. Heartbeats every 15 s. Filters:
`filter` (Logs Explorer query language), `severity`, `app_tla`, `service`, `q`. Long-poll
alternative: `GET /api/logs/tail?after_seq=<seq>&wait_seconds=30`. Hosted: replace
`http://localhost:4001` with `https://hackathon-incident-lab.kualia.workers.dev/logs`.

Entries use the GCP `LogEntry` shape: `severity`, `timestamp`, `labels.app_tla`,
`resource.labels.container_name`, `jsonPayload.message`, `jsonPayload.error.{type,message,stack_trace}`,
`httpRequest.status`, `trace`. Query examples:

```
severity>=ERROR AND labels.app_tla=("OLB" OR "MBL") AND jsonPayload.message:"customerId"
resource.labels.container_name="payments-api" httpRequest.status>=500 -"client disconnected"
```

## 6. ServiceNow activity feed (incidents from people, not logs)

Every journal entry on an incident or change request (opened, field changes, work notes,
comments), in the order ServiceNow recorded it. Use it to react to phone, email and chat
incidents from bankers without polling `list_incidents`.

```bash
# Long-poll: blocks up to 30 s, returns as soon as something matches. Pass back `cursor`.
curl -s "http://localhost:4002/api/activity/tail?after_seq=0&wait_seconds=30&kind=incident.opened&contact_type=phone,email,chat"
# Or Server-Sent Events, one `activity` event per entry, `id` = seq
curl -N "http://localhost:4002/api/activity/stream?table=incident"
```

Filters (comma-separated): `table` (`incident`, `change_request`), `kind` (`incident.opened`,
`incident.updated`, `incident.work_note`, `incident.comment`, and the same for
`change_request.*`), `app_tla`, `contact_type`. Each event has `seq`, `kind`, `number`,
`app_tla`, `at`, the journal `entry` (with `changes` for field updates), and the record as it is
now (`incident` or `change_request` summary). Omit `after_seq` to start live; `after_seq=0`
replays seeded history. The tail returns an `epoch` that changes when the world is reset (seqs
restart); the stream sends `event: reset`. Hosted: `https://hackathon-incident-lab.kualia.workers.dev/servicenow`.

From TypeScript, `@sim/contracts` has a long-poll follower for both tails:

```ts
import { createServiceNowClient } from '@sim/contracts/servicenow';

const sn = createServiceNowClient('http://localhost:4002');
for await (const ev of sn.followActivity({ kind: 'incident.opened', contact_type: 'phone,email,chat' })) {
  console.log(ev.number, ev.incident?.short_description);
}
```

## 7. Rules for the agent

- Find the root cause from the systems, not from `packages/scenarios`, the README spoilers or the
  simulator API. Don't hardcode TLAs, MR titles or fixes.
- Link everything with the `web_url` each entity returns, so a human can click through.
- Never try to merge or delete. Ask the humans in the channel to review and merge.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED` on 500x | `pnpm dev` isn't running, or is still starting |
| Tools return empty lists right after start | The world is still backfilling; wait for the control panel to say running |
| `pnpm sim trigger` refuses | Another scenario is active: `pnpm sim stop` or pass `--force` |
| `create_channel` conflict | Channel exists from an earlier run: `add_channel_members`, or `pnpm sim reset` |
| Run stays in `degrading` after the MR | Not merged yet, merged but no change request promoted it (merged = QV only), the change is still scheduled for later or KBR aborted it (see its work notes), or the fix is wrong |
