import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';

export type { CallToolResult, ToolAnnotations };
export { McpServer };

export interface McpServerSpec {
  /** Machine name, e.g. `servicenow`. */
  name: string;
  /** Display name, e.g. `ServiceNow (simulated)`. */
  title: string;
  version: string;
  /** Server-level guidance sent to the client on initialize. */
  instructions?: string;
  register(server: McpServer): void;
}

export function createMcpServer(spec: McpServerSpec): McpServer {
  const server = new McpServer(
    { name: spec.name, title: spec.title, version: spec.version },
    { instructions: spec.instructions },
  );
  spec.register(server);
  return server;
}

/**
 * Streamable HTTP MCP endpoint as a Hono app (stateless: a fresh server per request, JSON
 * responses): `ALL /mcp` and `GET /health`. Runs anywhere Hono runs (Node, Workers).
 */
export function createMcpHttpApp(spec: McpServerSpec): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', exposeHeaders: ['mcp-session-id'] }));
  app.get('/health', (c) => c.json({ status: 'ok', service: `${spec.name}-mcp` }));
  app.all('/mcp', async (c) => {
    const server = createMcpServer(spec);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}

/** Tool annotation presets. There are no destructive tools in this project. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const IDEMPOTENT_WRITE: ToolAnnotations = { ...WRITE, idempotentHint: true };

/** Standard pagination input fields. */
export const paginationShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe('Maximum number of items to return (1-100, default 25).'),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous response's next_cursor, to fetch the next page."),
};

/** Successful tool result: compact JSON text. */
export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
  };
}

/** Tool-level error the model can read and recover from. */
export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

type ShapeArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export interface ToolDef<S extends z.ZodRawShape> {
  title: string;
  /** Say what it does, when to use it, and what it returns. */
  description: string;
  input: S;
  annotations: ToolAnnotations;
  /** Return any JSON-serialisable value; thrown errors become `isError` results. */
  run: (args: ShapeArgs<S>) => Promise<unknown>;
}

/**
 * Registers a tool with a typed zod input schema. Errors (including REST `ApiError`s) are
 * returned as `isError` results with the message, so the agent can correct itself.
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  def: ToolDef<S>,
) {
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: { title: def.title, ...def.annotations },
    },
    // biome-ignore lint/suspicious/noExplicitAny: the SDK's callback generics don't line up with ZodRawShape inference
    (async (args: any) => {
      try {
        return ok(await def.run(args as ShapeArgs<S>));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }) as never,
  );
}
