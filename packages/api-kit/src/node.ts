import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

/** Node host: serves a Hono app on a port (multi-port local dev). Workers import the app instead. */
export function startApi(app: Hono, { port, service }: { port: number; service: string }) {
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
    console.log(`[${service}] listening on http://localhost:${port}`);
  });
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
