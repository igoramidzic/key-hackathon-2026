/**
 * The incident agent, hosted next to the world: one container (apps/incident-agent/Dockerfile)
 * behind one Durable Object, served at /agent. The guided demo reads its timeline from
 * /agent/api/stream and /agent/api/info.
 *
 * The agent is a long-lived Node process (the Claude Agent SDK runs Claude Code as a subprocess),
 * so it cannot run inside the Worker itself. It reaches the world like any outside client would:
 * through the public MCP endpoints, log stream and activity feed on this same origin.
 *
 * The first request starts the container; it stops AGENT_IDLE_MINUTES after the last request
 * ends. An open demo page holds its event stream open, which keeps the agent running.
 */
import { DurableObject } from 'cloudflare:workers';

export interface AgentEnv {
  /** Optional fixed public origin (defaults to the request's origin). */
  PUBLIC_URL?: string;
  /** Secret. Without it the agent runs its deterministic heuristics instead of Claude. */
  ANTHROPIC_API_KEY?: string;
  /** Scenario speed the agent is tuned for (the demo page triggers scenarios at this speed). */
  AGENT_SPEED?: string;
  AGENT_IDLE_MINUTES?: string;
  AGENT_MODEL?: string;
  AGENT_MODEL_DEEP?: string;
}

export const AGENT_PREFIX = '/agent';
const PORT = 8080;
/** A cold start pulls the image and boots Node; give it a while. */
const READY_TIMEOUT_MS = 120_000;

export const isAgentPath = (pathname: string) =>
  pathname === AGENT_PREFIX || pathname.startsWith(`${AGENT_PREFIX}/`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentHost extends DurableObject<AgentEnv> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    const container = ctx.container;
    // A restarted Durable Object (e.g. after a deploy) loses the timeout: set it again.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.idleMs()));
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return json(503, { error: 'no container is configured for the agent' });
    try {
      this.starting ??= this.start(new URL(req.url).origin).finally(() => {
        this.starting = undefined;
      });
      await this.starting;
    } catch (err) {
      console.error('[agent] start failed', err);
      return json(503, { error: 'the incident agent is starting', detail: String(err) });
    }

    const url = new URL(req.url);
    url.protocol = 'http:';
    url.host = 'container';
    url.pathname = url.pathname.slice(AGENT_PREFIX.length) || '/';
    const forwarded = new Request(url, req);
    forwarded.headers.delete('host');
    return container.getTcpPort(PORT).fetch(forwarded);
  }

  private idleMs(): number {
    return Number(this.env.AGENT_IDLE_MINUTES ?? 20) * 60_000;
  }

  private async start(origin: string): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      const key = this.env.ANTHROPIC_API_KEY;
      const env: Record<string, string> = {
        SIM_PUBLIC_URL: this.env.PUBLIC_URL || origin,
        AGENT_SPEED: this.env.AGENT_SPEED ?? '4',
        // As in `pnpm demo`: the agent closes the incident once recovery is confirmed.
        AGENT_AUTO_RESOLVE: 'true',
        AGENT_LLM: key ? 'claude' : 'off',
      };
      if (key) env.ANTHROPIC_API_KEY = key;
      if (this.env.AGENT_MODEL) env.AGENT_MODEL = this.env.AGENT_MODEL;
      if (this.env.AGENT_MODEL_DEEP) env.AGENT_MODEL_DEEP = this.env.AGENT_MODEL_DEEP;
      console.log(`[agent] starting container (${env.AGENT_LLM}, ${env.AGENT_SPEED}x)`);
      container.start({
        image: container.images.agent,
        instance: 'standard-1',
        // The world's public endpoints and the Claude API.
        enableInternet: true,
        env,
      });
    }
    await container.setInactivityTimeout(this.idleMs());

    const port = container.getTcpPort(PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch('http://container/api/info', {
          signal: AbortSignal.timeout(2_000),
        });
        await res.body?.cancel();
        if (res.ok) return;
        last = new Error(`/api/info returned ${res.status}`);
      } catch (err) {
        last = err;
      }
      await sleep(500);
    }
    throw new Error('the agent did not become ready', { cause: last });
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
