# The incident agent as a container, for the hosted demo (apps/cloudflare: AgentHost serves it at
# /agent). Build context is the repo root, so the workspace packages it imports are available.
#
# The agent needs a real Node process: the Claude Agent SDK runs Claude Code as a subprocess, which
# a Worker cannot. Configuration comes from the env that AgentHost passes at start (SIM_PUBLIC_URL,
# AGENT_SPEED, ANTHROPIC_API_KEY, ...), never from a baked-in .env (.dockerignore drops those).
FROM node:24-slim

ENV CI=true
RUN npm install -g pnpm@12.4.1 tsx@4.23.15 && npm cache clean --force

WORKDIR /app
COPY . .
# Only the agent and the workspace packages it depends on.
RUN pnpm install --frozen-lockfile --filter "@sim/incident-agent..." && pnpm store prune

# Claude Code refuses some modes as root; the agent writes only to AGENT_DATA_DIR and $HOME.
USER node
ENV NODE_ENV=production \
    AGENT_TIMELINE_PORT=8080 \
    AGENT_DATA_DIR=/tmp/incident-agent
EXPOSE 8080
CMD ["tsx", "apps/incident-agent/src/index.ts"]
