/** In-memory stand-in for the MCP gateway: register a handler per tool, inspect calls. */
import { type CallOptions, type Mcp, McpToolError } from '../src/mcp/gateway';
import { serverOf } from '../src/mcp/tools';

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export class FakeMcp implements Mcp {
  dryRun = false;
  readonly calls: { tool: string; args: Record<string, unknown>; opts?: CallOptions }[] = [];
  private readonly handlers = new Map<string, Handler>();

  on(tool: string, handler: Handler): this {
    serverOf(tool); // typo guard
    this.handlers.set(tool, handler);
    return this;
  }

  callsTo(tool: string) {
    return this.calls.filter((c) => c.tool === tool).map((c) => c.args);
  }

  async call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
    opts?: CallOptions,
  ): Promise<T> {
    this.calls.push({ tool, args, opts });
    const handler = this.handlers.get(tool);
    if (!handler) throw new McpToolError(serverOf(tool), tool, `no fake handler for ${tool}`);
    const out = await handler(args);
    if (out instanceof Error) throw out;
    return out as T;
  }
}

export const toolError = (tool: string, text: string) =>
  new McpToolError(serverOf(tool), tool, text);
