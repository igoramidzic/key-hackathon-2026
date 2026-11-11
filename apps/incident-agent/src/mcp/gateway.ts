/**
 * Deterministic MCP client used by the orchestrator for every read and every write.
 *
 * - One Streamable HTTP client per server, created lazily and recreated after connection errors.
 * - `call(tool, args)` parses the JSON text content, retries connection errors and 5xx with
 *   backoff, and throws McpToolError for tool errors (e.g. an unknown user with suggestions).
 * - Every call is reported to `onCall` (the case timeline) with short args, duration and outcome.
 * - With dryRun, write tools are logged and answered with a stub instead of being called.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ServerName } from '../config';
import { backoffMs, errorMessage, short, sleep } from '../util';
import { isReadTool, serverOf } from './tools';

export interface ToolCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

export interface ToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

export type ClientFactory = (server: ServerName, url: string) => Promise<ToolClient>;

export interface ToolCallRecord {
  server: ServerName;
  tool: string;
  args: string;
  ms: number;
  ok: boolean;
  error?: string;
  dryRun?: boolean;
  attempts: number;
  caseId?: string;
}

export interface CallOptions {
  /** Case the call belongs to (for the timeline). */
  caseId?: string;
  /** Don't report to the timeline (polling). */
  quiet?: boolean;
  /** Retries for transient failures (default 3). */
  retries?: number;
}

/** The tool ran and returned an error result (bad input, unknown user, 404, 409, …). */
export class McpToolError extends Error {
  override name = 'McpToolError';
  constructor(
    readonly server: ServerName,
    readonly tool: string,
    readonly text: string,
  ) {
    super(`${tool}: ${text}`);
  }
  /** Best-effort: the tool said the thing doesn't exist. */
  get notFound(): boolean {
    return /not found|unknown|no such|does not exist/i.test(this.text);
  }
  get conflict(): boolean {
    return /already exists|conflict|duplicate/i.test(this.text);
  }
}

/** The interface every caller depends on, so tests can swap in a fake. */
export interface Mcp {
  call<T = unknown>(tool: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  readonly dryRun: boolean;
}

export const httpClientFactory: ClientFactory = async (_server, url) => {
  const client = new Client({ name: 'sim-incident-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolCallResult>,
    listTools: async () => (await client.listTools()).tools.map((t) => t.name),
    close: () => client.close(),
  };
};

export function isTransient(err: unknown): boolean {
  if (err instanceof McpToolError) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: string };
  if (typeof e?.code === 'number' && (e.code >= 500 || e.code === 429 || e.code === 408))
    return true;
  const codes = [e?.code, e?.cause?.code].filter((c) => typeof c === 'string');
  if (codes.some((c) => /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR/.test(String(c))))
    return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|network|timed? ?out|HTTP 5\d\d/i.test(
    e?.message ?? '',
  );
}

export function parseToolResult(result: ToolCallResult): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let dryCounter = 0;
/** Plausible stub for a write in dry-run mode, so the flow can keep going. */
function dryRunStub(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  dryCounter++;
  const n = String(dryCounter).padStart(4, '0');
  return {
    dry_run: true,
    tool,
    ...args,
    number: tool.includes('change') ? `CHGDRY${n}` : `INCDRY${n}`,
    id: `dry_${n}`,
    iid: dryCounter,
    name: args.name ?? `dry-${n}`,
    web_url: `about:blank#dry-run-${tool}-${n}`,
    state: 'opened',
  };
}

export interface GatewayOptions {
  urls: Record<ServerName, string>;
  dryRun?: boolean;
  factory?: ClientFactory;
  onCall?: (record: ToolCallRecord) => void;
  /** Called for dry-run writes (to print them). */
  onDryRun?: (tool: string, args: Record<string, unknown>) => void;
  /** Override for tests (no real sleeping). */
  sleep?: (ms: number) => Promise<void>;
}

export class McpGateway implements Mcp {
  readonly dryRun: boolean;
  private readonly clients = new Map<ServerName, Promise<ToolClient>>();
  private readonly factory: ClientFactory;
  private readonly pause: (ms: number) => Promise<void>;
  onCall?: (record: ToolCallRecord) => void;

  constructor(private readonly opts: GatewayOptions) {
    this.dryRun = Boolean(opts.dryRun);
    this.factory = opts.factory ?? httpClientFactory;
    this.pause = opts.sleep ?? ((ms) => sleep(ms));
    this.onCall = opts.onCall;
  }

  private client(server: ServerName): Promise<ToolClient> {
    let c = this.clients.get(server);
    if (!c) {
      c = this.factory(server, this.opts.urls[server]);
      // A failed connect must not be cached.
      c.catch(() => this.clients.delete(server));
      this.clients.set(server, c);
    }
    return c;
  }

  private async drop(server: ServerName): Promise<void> {
    const c = this.clients.get(server);
    this.clients.delete(server);
    try {
      await (await c)?.close();
    } catch {
      // already gone
    }
  }

  async listTools(server: ServerName): Promise<string[]> {
    return (await this.client(server)).listTools();
  }

  async call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
    opts: CallOptions = {},
  ): Promise<T> {
    const server = serverOf(tool);
    const started = Date.now();
    const report = (rec: Omit<ToolCallRecord, 'server' | 'tool' | 'args' | 'ms' | 'caseId'>) => {
      if (opts.quiet && rec.ok) return;
      this.onCall?.({
        server,
        tool,
        args: short(args, 240),
        ms: Date.now() - started,
        caseId: opts.caseId,
        ...rec,
      });
    };

    if (this.dryRun && !isReadTool(tool)) {
      this.opts.onDryRun?.(tool, args);
      report({ ok: true, dryRun: true, attempts: 0 });
      return dryRunStub(tool, args) as T;
    }

    const retries = opts.retries ?? 3;
    let attempt = 0;
    for (;;) {
      try {
        const client = await this.client(server);
        const result = await client.callTool(tool, args);
        const value = parseToolResult(result);
        if (result.isError) {
          throw new McpToolError(server, tool, typeof value === 'string' ? value : short(value));
        }
        report({ ok: true, attempts: attempt + 1 });
        return value as T;
      } catch (err) {
        if (attempt < retries && isTransient(err)) {
          await this.drop(server);
          await this.pause(backoffMs(attempt));
          attempt++;
          continue;
        }
        report({ ok: false, error: errorMessage(err).slice(0, 300), attempts: attempt + 1 });
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((s) => this.drop(s)));
  }
}
