# @sim/incident-agent

The incident agent: it watches the simulated bank, notices when something breaks, runs the
incident process end to end and needs humans only to review the fix and click **Merge**.
Epic: GitHub issue #28. Building against the world: [docs/AGENT-GUIDE.md](../../docs/AGENT-GUIDE.md).

```bash
pnpm dev                 # the world (the agent is not part of it)
pnpm agent --check       # connectivity: tools/list on the 4 MCP servers + both live feeds
pnpm agent               # run the agent; live timeline at http://localhost:4100
pnpm agent cases         # cases on disk with phase and links
pnpm agent case <id>     # one case's timeline (id prefix or incident number)
pnpm agent watch         # the detectors only: print signals, take no action
pnpm agent timeline      # serve the live timeline from the cases on disk
pnpm agent:eval          # run every scenario unattended and print a scorecard
```

Demo: `pnpm sim reset`, start `pnpm agent` (with `AGENT_SPEED=4` to match), then
`pnpm sim trigger cif-snake-case-cascade --speed 4`. Watch the timeline page and the Teams channel;
merge the fix MR in GitLab when the agent asks.

## How it works

```
log stream ─┐
Moogsoft ───┼─▶ correlator ─▶ case ─▶ triage ─▶ quick RCA ─▶ incident ─▶ channel ─▶ briefing
SNOW feed ──┘   (one problem,          │                                               │
                one case)              └─ deep RCA (background) ─▶ fix MR ─▶ human merges
                                                                              │
             resolution ◀─ verify recovery ◀─ KBR promotes ◀─ emergency CHG ◀─┘
```

- **Detection** (`watchers/`): spike detection per (app, service) on the WARNING+ log stream
  against a learned baseline; calls from bankers on the ServiceNow activity feed; new Moogsoft
  alerts.
- **Correlation** (`correlate/`): scores a failing app against open cases on traces, errors that
  name the same upstream app, direct calls, error signatures, a shared upstream and timing (timing
  alone never joins). A cascade becomes one case with its shared upstream candidates.
- **The flow** (`flow/steps.ts`): one idempotent step per phase,
  `detected → triaged → declared → assembled → briefed → investigating → fix_proposed →
  awaiting_merge → shipping → verifying → resolution_drafted → resolved`, run by the orchestrator
  (`cases/`), with deep RCA, fix generation and caller grouping in the background. Every create is
  found again by a natural key after a crash (correlation id, channel name, MR branch, CHG).
- **Upkeep** on every step after declaring: link new alerts, re-point the incident when the root
  cause changes, add late joiners to the channel, group callers, read the channel and answer,
  merge or split cases, and post coalesced status updates mirrored as work notes.

## Deterministic plumbing, LLM for judgment

Every phase works without a model: triage, RCA (ranking promoted changes by how many failing apps
depend on them, timing and diff relevance), the revert fix, caller grouping and chat all have a
deterministic implementation. With `ANTHROPIC_API_KEY` set (`AGENT_LLM=auto`), read-only Claude
Agent SDK phases refine them: Sonnet for triage, grouping and chat, Opus for RCA and the fix.
Phases get read tools only and return JSON validated with zod; the orchestrator performs every
write, and every link comes from a tool result (`phases/runner.ts`, `phases/claude.ts`).

## Layout

```
src/
  index.ts        CLI entry
  agent.ts        wiring: gateway, store, graph, correlator, watchers, orchestrator, timeline
  config.ts       env → URLs (local ports or SIM_PUBLIC_URL), models, thresholds (zod)
  check.ts        startup connectivity check
  mcp/            MCP gateway (retries, dry run, timeline) and the read/write tool lists
  watchers/       log stream + spike detector, ServiceNow feed, Moogsoft alerts
  correlate/      dependency graph, evidence, signals → cases
  cases/          case model, store, orchestrator, CLI
  phases/         LLM phase runner and the Claude provider
  flow/           the steps and their deterministic actions: triage, rca, incident, assemble,
                  announce, fix, ship, verify, callers, chat, regroup
  messages/       Teams message templates (snapshot-tested)
  timeline/       live case timeline server and page
eval/             scenario harness and scorecard (the only place allowed to touch the simulator API)
test/             vitest; fixtures are recorded logs and the CMDB graph
```

`.data/` (cases, transcripts, eval scorecards) is gitignored.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SIM_PUBLIC_URL` | unset | Use the hosted world (`<base>/<system>/mcp`, feeds under `<base>/logs`, `<base>/servicenow`) |
| `AGENT_LLM` | `auto` | `claude`, `off` (deterministic only), or `auto` (Claude when `ANTHROPIC_API_KEY` is set) |
| `ANTHROPIC_API_KEY` | unset | Credentials for the Claude Agent SDK |
| `AGENT_MODEL` / `AGENT_MODEL_DEEP` | `claude-sonnet-5-5` / `claude-opus-5-5` | Fast phases / RCA and fix |
| `AGENT_DRY_RUN` | `false` | Log write tools instead of calling them |
| `AGENT_AUTO_RESOLVE` | `false` | Resolve the incident after recovery instead of drafting the resolution |
| `AGENT_SPEED` | `1` | The scenario `--speed`; shortens settle, verification and polling windows |
| `AGENT_TIMELINE_PORT` | `4100` | Live timeline (`0` = any free port) |
| `AGENT_DATA_DIR` | `apps/incident-agent/.data` | Case state and transcripts |

Detection, correlation, RCA and verification thresholds (`AGENT_DETECT_*`, `AGENT_SETTLE_SEC`,
`AGENT_JOIN_SCORE`, `AGENT_RCA_CONFIDENCE`, `AGENT_VERIFY_*`, …) are listed in `src/config.ts`.
Invalid values fail at start with a message naming the variable.

## The answer key is off limits

Code under `src/` must find root causes from logs, ServiceNow and GitLab. Biome's
`noRestrictedImports` (override in the root `biome.json`) rejects imports of `@sim/scenarios`,
`@sim/contracts/simulator`, `@sim/simulator` and `@sim/world` there, and
`test/answer-key-guard.test.ts` greps `src/` for the simulator port and `/api/scenarios`.
Only `eval/` may use the simulator API, to score runs. No TLA, MR title or fix is hardcoded.

`pnpm agent` is deliberately left out of `pnpm dev`, so the world runs without it.
