# AGENTS.md

Orientation for coding agents (Claude Code, Codex, Cursor, …) working in this repo.

## What this repo is

A **simulated bank IT estate** for an automated incident-resolution agent. Four mock systems
(Logs + Moogsoft alerts, ServiceNow, GitLab, Teams), each with a REST API, a web UI and an MCP
server, plus a simulator that runs background traffic and triggers incident scenarios.

The **incident agent** lives in `apps/incident-agent` (`@sim/incident-agent`). It talks to the
world only through the four MCP servers, the live log stream and the ServiceNow activity feed.
There are two kinds of work here:

| You are… | Read |
| --- | --- |
| Building or running the **incident agent** against the simulated world | [apps/incident-agent/README.md](apps/incident-agent/README.md) and [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) |
| Changing the **simulated world** (systems, scenarios, UIs, simulator) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

[README.md](README.md) is the human overview: ports, scenarios, tool list, Cloudflare hosting.
Humans browsing the tools should use the interactive docs at <http://localhost:3000/docs>
(`apps/control-panel/src/docs`). That page reads `tools/list` live, so new or changed tools
appear there automatically. Curated "Try it" arguments live in
`apps/control-panel/src/docs/examples.ts`: add one when you add a tool.

## Commands

```bash
pnpm install
pnpm dev                                   # all 14 processes; control panel on :3000
pnpm sim list | status | reset | stop      # drive the simulator from the CLI
pnpm sim trigger cif-snake-case-cascade --speed 4
pnpm agent --check                         # incident agent: connectivity check (not part of pnpm dev)
pnpm agent                                 # run the incident agent against the world
pnpm e2e                                   # end-to-end check against the running stack
pnpm test && pnpm typecheck && pnpm lint   # run before committing
```

`pnpm dev` must be running for the MCP servers, the CLI and `pnpm e2e` to work. To use the hosted
copy instead, set `SIM_PUBLIC_URL=https://hackathon-incident-lab.kualia.workers.dev`.

## MCP servers

`.mcp.json` at the repo root registers the four local servers (`sim-logs`, `sim-servicenow`,
`sim-gitlab`, `sim-teams`) for Claude Code. They answer only while `pnpm dev` is running.

| Server | Local | Hosted |
| --- | --- | --- |
| logs | `http://localhost:5001/mcp` | `https://hackathon-incident-lab.kualia.workers.dev/logs/mcp` |
| servicenow | `http://localhost:5002/mcp` | `…/servicenow/mcp` |
| gitlab | `http://localhost:5003/mcp` | `…/gitlab/mcp` |
| teams | `http://localhost:5004/mcp` | `…/teams/mcp` |

## Rules

- **Don't read the answer key when acting as, or building, the incident agent.** The culprits and
  fixes live in `packages/scenarios`, the README's spoiler section and the simulator API
  (`GET :4000/api/scenarios/:id`). The agent must find root causes from logs, ServiceNow and
  GitLab, never from those. Hardcoding a TLA, MR title or fix makes the demo meaningless.
- Keep world changes deterministic (seed 2026, `new Rng('<stable key>')`) and working in both
  hosting modes (multi-port Node and the single Cloudflare Worker). See ARCHITECTURE.md.
- MCP tools have no delete and no merge on purpose. A human merges fix MRs in the GitLab UI.
- TypeScript strict, `import type` for types, Biome for formatting (`pnpm format`).
