/**
 * Startup connectivity check: tools/list on all four MCP servers, plus one request each to the
 * live log stream and the ServiceNow activity feed. Used by `pnpm agent --check` and on start.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentConfig, ServerName } from './config';
import { SERVERS } from './config';
import { color } from './log';

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function timed(name: string, fn: () => Promise<string>): Promise<CheckItem> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, ms: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, ok: false, detail: message.slice(0, 200), ms: Date.now() - start };
  }
}

async function listTools(url: string): Promise<string[]> {
  const client = new Client({ name: 'incident-agent-check', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function runChecks(config: AgentConfig): Promise<CheckItem[]> {
  const mcp = SERVERS.map((server: ServerName) =>
    timed(`mcp ${server}`, async () => {
      const tools = await listTools(config.mcp[server]);
      return `${tools.length} tools at ${config.mcp[server]}`;
    }),
  );
  const stream = timed('log stream', async () => {
    const tail = await getJson(`${config.logsApi}/api/logs/tail?limit=1`);
    return `last_seq ${tail.last_seq} at ${config.logsApi}/api/logs/stream`;
  });
  const feed = timed('snow feed', async () => {
    const tail = await getJson(`${config.serviceNowApi}/api/activity/tail?limit=1`);
    return `last_seq ${tail.last_seq}, epoch ${tail.epoch} at ${config.serviceNowApi}/api/activity`;
  });
  return Promise.all([...mcp, stream, feed]);
}

export function printChecks(items: CheckItem[], config: AgentConfig): boolean {
  console.log(color.bold('Incident agent connectivity'));
  console.log(
    color.dim(
      `  world: ${config.hosted ? 'hosted' : 'local'} · llm: ${config.llm.mode} (${config.llm.reason})` +
        `${config.dryRun ? ' · DRY RUN' : ''}`,
    ),
  );
  for (const item of items) {
    const mark = item.ok ? color.green('✓') : color.red('✗');
    console.log(`  ${mark} ${item.name.padEnd(16)} ${item.detail} ${color.dim(`${item.ms}ms`)}`);
  }
  const ok = items.every((i) => i.ok);
  if (!ok) {
    console.log(
      color.yellow('  Is the world running? Start it with `pnpm dev` or set SIM_PUBLIC_URL.'),
    );
  }
  return ok;
}
