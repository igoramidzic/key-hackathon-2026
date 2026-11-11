# @sim/incident-agent

The incident agent: it watches the simulated bank, notices when something breaks, runs the
incident process end to end and needs humans only to review the fix and click **Merge**.
Epic: GitHub issue #28. Building against the world: [docs/AGENT-GUIDE.md](../../docs/AGENT-GUIDE.md).

```bash
pnpm dev                 # the world (the agent is not part of it)
pnpm agent --check       # connectivity: tools/list on the 4 MCP servers + both live feeds
pnpm agent               # run the agent
```

## Layout

```
src/
  index.ts        entry: start the watchers and the orchestrator
  config.ts       env → URLs (local ports or SIM_PUBLIC_URL), models, thresholds (zod)
  check.ts        startup connectivity check
  mcp/            MCP clients for logs / servicenow / gitlab / teams
  watchers/       log stream, ServiceNow feed, Moogsoft alerts
  correlate/      signals → cases
  cases/          case model, store, state machine
  phases/         LLM phases: triage, rca, fix, grouping, chat
  actions/        deterministic writes: incident, channel, messages, MR, CHG
  messages/       Teams + ServiceNow message templates
eval/             scenario harness (the only place allowed to touch the simulator API)
test/
```

`.data/` (case state, transcripts, eval scorecards) is gitignored.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SIM_PUBLIC_URL` | unset | Use the hosted world (`<base>/<system>/mcp`, feeds under `<base>/logs`, `<base>/servicenow`) |
| `AGENT_LLM` | `auto` | `claude`, `off` (deterministic heuristics), or `auto` (Claude when `ANTHROPIC_API_KEY` is set) |
| `ANTHROPIC_API_KEY` | unset | Credentials for the Claude Agent SDK |
| `AGENT_MODEL` / `AGENT_MODEL_DEEP` | `claude-sonnet-5-5` / `claude-opus-5-5` | Fast phases / RCA and fix |
| `AGENT_DRY_RUN` | `false` | Log write tools instead of calling them |
| `AGENT_AUTO_RESOLVE` | `false` | Resolve the incident after recovery instead of leaving a drafted resolution |
| `AGENT_SPEED` | `1` | The scenario `--speed`; shortens settle and verification windows |
| `AGENT_DATA_DIR` | `apps/incident-agent/.data` | Case state and transcripts |

Detection and correlation thresholds (`AGENT_DETECT_*`, `AGENT_SETTLE_SEC`, `AGENT_JOIN_SCORE`, …)
are listed in `src/config.ts`. Invalid values fail at start with a message naming the variable.

## The answer key is off limits

Code under `src/` must find root causes from logs, ServiceNow and GitLab. Biome's
`noRestrictedImports` (override in the root `biome.json`) rejects imports of `@sim/scenarios`,
`@sim/contracts/simulator`, `@sim/simulator` and `@sim/world` there, and
`test/answer-key-guard.test.ts` greps `src/` for the simulator port and `/api/scenarios`.
Only `eval/` may use the simulator API, to score runs.

`pnpm agent` is deliberately left out of `pnpm dev`, so the world runs without it.
