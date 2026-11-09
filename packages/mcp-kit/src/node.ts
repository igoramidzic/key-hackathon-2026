import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpHttpApp, createMcpServer, type McpServerSpec } from './index';

/** Node host: serves the MCP server at `http://localhost:<port>/mcp`. */
export function serveMcpHttp(spec: McpServerSpec, port: number) {
  const httpServer = serve(
    { fetch: createMcpHttpApp(spec).fetch, port, hostname: '0.0.0.0' },
    () => {
      console.log(`[${spec.name}-mcp] MCP endpoint http://localhost:${port}/mcp`);
    },
  );
  const shutdown = () => {
    httpServer.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return httpServer;
}

/** Serves the MCP server over stdio. Never write to stdout in stdio mode. */
export async function serveMcpStdio(spec: McpServerSpec) {
  const server = createMcpServer(spec);
  await server.connect(new StdioServerTransport());
}
