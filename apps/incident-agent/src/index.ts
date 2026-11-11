import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type AgentConfig, getConfig } from './config.js';

export interface McpCheckResult {
  system: string;
  url: string;
  ok: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  durationMs: number;
}

export interface StreamCheckResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  error?: string;
  durationMs: number;
}

export interface ConnectivitySummary {
  mcpResults: McpCheckResult[];
  streamResults: StreamCheckResult[];
  allPassed: boolean;
}

export async function checkMcpServer(
  system: string,
  url: string,
  timeoutMs = 5000,
): Promise<McpCheckResult> {
  const start = Date.now();
  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = new Client({ name: `incident-agent-check-${system}`, version: '0.1.0' });
    transport = new StreamableHTTPClientTransport(new URL(url));
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([connectPromise, timeoutPromise]);
    clearTimeout(timer);
    timer = undefined;

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    return {
      system,
      url,
      ok: true,
      toolCount: toolNames.length,
      tools: toolNames,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      system,
      url,
      ok: false,
      toolCount: 0,
      tools: [],
      error,
      durationMs: Date.now() - start,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function checkStream(
  name: string,
  url: string,
  timeoutMs = 5000,
): Promise<StreamCheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  try {
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    const ok = res.ok;
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        // Stream cancel ignored
      }
    }
    return {
      name,
      url,
      ok,
      status: res.status,
      contentType,
      error: ok ? undefined : `HTTP status ${res.status}`,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      name,
      url,
      ok: false,
      error,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function runConnectivityChecks(
  config: AgentConfig = getConfig(),
): Promise<ConnectivitySummary> {
  const mcpTargets = [
    { system: 'logs', url: config.urls.mcp.logs },
    { system: 'servicenow', url: config.urls.mcp.servicenow },
    { system: 'gitlab', url: config.urls.mcp.gitlab },
    { system: 'teams', url: config.urls.mcp.teams },
  ];

  const streamTargets = [
    { name: 'log stream', url: config.urls.streams.logs },
    { name: 'activity stream', url: config.urls.streams.activity },
  ];

  const mcpResults = await Promise.all(mcpTargets.map((t) => checkMcpServer(t.system, t.url)));

  const streamResults = await Promise.all(streamTargets.map((t) => checkStream(t.name, t.url)));

  const allPassed = mcpResults.every((r) => r.ok) && streamResults.every((r) => r.ok);

  return { mcpResults, streamResults, allPassed };
}

export function printSummary(summary: ConnectivitySummary): void {
  console.log('\nIncident Agent Connectivity Check');
  console.log('===================================');

  console.log('\nMCP Servers:');
  for (const r of summary.mcpResults) {
    const icon = r.ok ? '✔' : '✘';
    const statusText = r.ok
      ? `${r.toolCount} tools (${r.durationMs}ms)`
      : `FAILED: ${r.error} (${r.durationMs}ms)`;
    console.log(`  ${icon} [${r.system}] ${r.url} -> ${statusText}`);
    if (r.ok && r.tools.length > 0) {
      console.log(`    tools: ${r.tools.join(', ')}`);
    }
  }

  console.log('\nEvent Streams:');
  for (const s of summary.streamResults) {
    const icon = s.ok ? '✔' : '✘';
    const statusText = s.ok
      ? `HTTP ${s.status} [${s.contentType || 'ok'}] (${s.durationMs}ms)`
      : `FAILED: ${s.error} (${s.durationMs}ms)`;
    console.log(`  ${icon} [${s.name}] ${s.url} -> ${statusText}`);
  }

  const total = summary.mcpResults.length + summary.streamResults.length;
  const passed =
    summary.mcpResults.filter((r) => r.ok).length +
    summary.streamResults.filter((s) => s.ok).length;

  console.log('\nSummary:');
  if (summary.allPassed) {
    console.log(`  All ${total} checks passed successfully.`);
  } else {
    console.log(`  ${passed}/${total} checks passed. ${total - passed} checks failed.`);
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const config = getConfig();

  if (isCheck) {
    const summary = await runConnectivityChecks(config);
    printSummary(summary);
    if (!summary.allPassed) {
      process.exit(1);
    }
    return;
  }

  console.log('Starting @sim/incident-agent...');
  console.log(`  Model: ${config.models.agent}`);
  console.log(`  Dry run: ${config.dryRun}`);
  console.log(`  Auto resolve: ${config.autoResolve}`);
  console.log(
    `  Error threshold: ${config.thresholds.errorThreshold} errors / ${config.thresholds.windowSeconds}s`,
  );
  console.log(
    `  MCP endpoints: logs=${config.urls.mcp.logs}, servicenow=${config.urls.mcp.servicenow}, gitlab=${config.urls.mcp.gitlab}, teams=${config.urls.mcp.teams}`,
  );
  console.log(
    `  Stream endpoints: logs=${config.urls.streams.logs}, activity=${config.urls.streams.activity}`,
  );
  console.log('Agent scaffold initialized. Use --check to verify connectivity to all systems.');
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('/incident-agent/src/index.ts') ||
    process.argv[1].endsWith('/incident-agent/src/index.js') ||
    process.argv[1].endsWith('@sim/incident-agent'));

if (isDirectExecution || process.argv.includes('--check')) {
  main().catch((err) => {
    console.error('Fatal incident agent error:', err);
    process.exit(1);
  });
}
