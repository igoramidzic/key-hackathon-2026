# @sim/incident-agent

The incident agent: it watches the simulated bank, notices when something breaks, runs the
incident process end to end and needs humans only to review the fix and click **Merge**.
Epic: GitHub issue #28. Building against the world: [docs/AGENT-GUIDE.md](../../docs/AGENT-GUIDE.md).

```bash
pnpm dev                 # the world (the agent is not part of it)
pnpm agent --check       # connectivity: the 4 MCP servers, both live feeds and the model
pnpm agent               # run the agent (AI phases with Claude); live timeline at http://localhost:4100
pnpm agent --deterministic   # the same without a model: deterministic heuristics only
pnpm agent cases         # cases on disk with phase and links
pnpm agent case <id>     # one case's timeline (id prefix or incident number)
pnpm agent watch         # the detectors only: print signals, take no action
pnpm agent timeline      # serve the live timeline from the cases on disk
pnpm agent:eval          # run every scenario unattended and print a scorecard (--deterministic too)
```

The AI phases need Claude credentials. The agent uses, in order, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or the Claude Code login (`claude auth login`).
Put the key or token in `apps/incident-agent/.env` (gitignored; it never overrides variables that
are already set). `pnpm agent --check` pings the model, and the agent refuses to start in AI mode
when the model can't be reached, rather than quietly running without it.

Demo: `pnpm demo` starts the agent and opens the guided demo (<http://localhost:3000/demo>), which
resets the world, triggers the scenario and walks through the run step by step; see the root
README. By hand: `pnpm sim reset`, `AGENT_SPEED=4 pnpm agent`, then
`pnpm sim trigger cif-snake-case-cascade --speed 4`, watch the timeline page and merge the fix MR
in GitLab when the agent asks.

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

## AI for judgment, deterministic plumbing

Watching the feeds, correlating signals into cases, the state machine and every write are plain
code. The judgment is Claude's: by default every phase is a read-only Claude Agent SDK
investigation that returns JSON validated with zod.

| Phase | Model | Tools |
| --- | --- | --- |
| Triage: scope, onset, severity, log links, grouping check | `AGENT_MODEL` (Sonnet) | logs, CMDB |
| Quick RCA: up to three suspect changes for the briefing | `AGENT_MODEL` (Sonnet) | changes, MRs, CMDB, logs |
| Deep RCA: the culprit, its mechanism, evidence, what's ruled out | `AGENT_MODEL_DEEP` (Opus) | changes, MRs, code, logs, CMDB |
| Fix: revert or forward fix, validated against main | `AGENT_MODEL_DEEP` (Opus) | GitLab read tools |
| Caller grouping, chat classification and answers | `AGENT_MODEL` (Sonnet) | none / read tools |

Phases get read tools only (`phases/runner.ts`, `phases/claude.ts`); the orchestrator performs every
write. Whatever the model names is checked against the systems: change requests and MRs must exist
(their links come from the tools), log links are re-resolved through `search_logs`, fixes must apply
to main and touch only the culprit's files.

**Deterministic mode** (`AGENT_LLM=off` or `--deterministic`) replaces each phase with code: ranking
promoted changes by how many failing apps depend on them, timing and diff relevance; a mechanical
revert; vocabulary matching for calls. In AI mode the same code is only a fallback when an AI phase
fails, and the timeline says so ("AI deep RCA failed …; falling back").

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
| `AGENT_LLM` | `claude` | `claude` (AI phases) or `off` / `deterministic` (no model) |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | unset | Claude credentials; else the Claude Code login |
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
