# @sim/incident-agent

Automated incident-resolution agent operating against the simulated bank IT estate.

The agent investigates and resolves incidents exclusively through the four MCP servers
(Logs + Moogsoft, ServiceNow, GitLab, Teams) and the live event streams (Cloud Logging SSE stream
and ServiceNow activity feed).

## Architecture & Layout

```
apps/incident-agent/
├── src/
│   ├── index.ts        # Entrypoint & connectivity check (--check)
│   ├── config.ts       # Zod-validated configuration (URLs, keys, models, thresholds)
│   ├── mcp/            # MCP client wrappers (logs, servicenow, gitlab, teams)
│   ├── watchers/       # Live stream watchers (SSE log stream, activity tail)
│   ├── correlate/      # Symptom correlation across alerts, logs, and dependencies
│   ├── cases/          # Incident case tracking & duplicate grouping
│   ├── phases/         # Resolution phases (detect, scope, trace, fix, verify)
│   ├── actions/        # Tool-driven action execution
│   └── messages/       # Incident communication & Teams channel templates
├── eval/               # Evaluation benchmark definitions & scenario runs
├── test/               # Vitest test suite (including answer-key guard)
├── package.json
└── tsconfig.json
```

## Configuration

Configuration is loaded from environment variables and validated at startup using Zod:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIM_PUBLIC_URL` | _unset_ | Base URL for hosted world (e.g. `https://hackathon-incident-lab.kualia.workers.dev`). Sets all MCP and stream endpoints. |
| `SIM_HOST` | `localhost` | Host for multi-port local estate. |
| `LOGS_MCP_URL` | `http://localhost:5001/mcp` | Logs & Moogsoft MCP endpoint |
| `SERVICENOW_MCP_URL` | `http://localhost:5002/mcp` | ServiceNow MCP endpoint |
| `GITLAB_MCP_URL` | `http://localhost:5003/mcp` | GitLab MCP endpoint |
| `TEAMS_MCP_URL` | `http://localhost:5004/mcp` | Teams MCP endpoint |
| `LOG_STREAM_URL` | `http://localhost:4001/api/logs/stream` | Live log SSE stream |
| `ACTIVITY_STREAM_URL` | `http://localhost:4002/api/activity/stream` | ServiceNow activity SSE feed |
| `ANTHROPIC_API_KEY` | _unset_ | Anthropic API key |
| `GEMINI_API_KEY` | _unset_ | Google Gemini API key |
| `ANTHROPIC_MODEL` | `claude-3-7-sonnet-20250219` | Default Anthropic model |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Default Gemini model |
| `AGENT_MODEL` | `claude-3-7-sonnet-20250219` | Model selected for the incident agent |
| `AGENT_DRY_RUN` | `false` | When true, skips destructive write actions |
| `AGENT_AUTO_RESOLVE` | `false` | When true, resolves incidents automatically |
| `DETECTION_ERROR_THRESHOLD` | `5` | Error count to trigger incident investigation |
| `DETECTION_WINDOW_SECONDS` | `60` | Sliding window in seconds for error spikes |
| `DETECTION_WARNING_THRESHOLD` | `20` | Warning count threshold |

## Running

Ensure the simulation estate is running (`pnpm dev` or pointing at `SIM_PUBLIC_URL`).

### Connectivity check

Verify that all 4 MCP servers are reachable, list their tools, and ping the log and activity streams:

```bash
pnpm --filter @sim/incident-agent start -- --check
# or via tsx:
pnpm agent -- --check
```

### Starting the agent

```bash
pnpm agent
# or
pnpm --filter @sim/incident-agent start
```

## Answer-Key Guard

The agent package adheres to strict estate isolation rules:
- **No answer-key imports**: `src/` must never import `@sim/scenarios` or `@sim/contracts/simulator`.
- **No simulator API calls**: The agent must never call port `:4000` or `/api/scenarios`.
- **Linter enforcement**: Biome rule `noRestrictedImports` fails if forbidden modules are imported in `apps/incident-agent/src/`.
- **Automated test**: `test/answer-key-guard.test.ts` scans all source files to verify compliance.

## Testing & Typechecking

```bash
pnpm --filter @sim/incident-agent typecheck
pnpm --filter @sim/incident-agent test
```
