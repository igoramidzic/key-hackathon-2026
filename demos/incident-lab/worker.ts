import { DurableObject } from 'cloudflare:workers';
import { Simulation, type SimulationSnapshot, type ControlInput } from './simulation';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One durable simulation per browser or explicitly shared room, never one global demo. */
export class IncidentRoom extends DurableObject<Cloudflare.Env> {
  private simulation = new Simulation();
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSaved = 0;
  private encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
    );
    const saved = ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM snapshot WHERE id = 1')
      .toArray()[0];
    if (saved) this.simulation.restore(JSON.parse(saved.value) as SimulationSnapshot);
  }
  private persist() {
    this.ctx.storage.sql.exec(
      'INSERT INTO snapshot (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
      JSON.stringify(this.simulation.snapshot()),
    );
    this.lastSaved = Date.now();
  }
  private emit() {
    const chunk = this.encoder.encode(
      `event: state\ndata: ${JSON.stringify(this.simulation.state())}\n\n`,
    );
    for (const client of this.clients) {
      try {
        if ((client.desiredSize ?? 0) > 0) client.enqueue(chunk);
      } catch {
        this.clients.delete(client);
      }
    }
    if (!this.clients.size) this.stop();
  }
  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.persist();
  }
  private stream(): Response {
    if (this.clients.size >= 20)
      return json({ error: 'This room already has 20 live viewers.' }, 429);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (current) => {
        controller = current;
        this.clients.add(current);
        current.enqueue(
          this.encoder.encode(`event: state\ndata: ${JSON.stringify(this.simulation.state())}\n\n`),
        );
      },
      cancel: () => {
        this.clients.delete(controller);
        if (!this.clients.size) this.stop();
      },
    });
    if (!this.timer)
      this.timer = setInterval(() => {
        try {
          const previousPhase = this.simulation.simulation.phase;
          this.simulation.tick();
          // Active telemetry is checkpointed; mutations are persisted before responses.
          if (
            previousPhase !== this.simulation.simulation.phase ||
            Date.now() - this.lastSaved >= 5000
          )
            this.persist();
          this.emit();
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'simulation_tick_failed',
              message: error instanceof Error ? error.message : 'unknown',
            }),
          );
          for (const client of this.clients) client.error(error);
          this.clients.clear();
          if (this.timer) clearInterval(this.timer);
          this.timer = undefined;
        }
      }, 1000);
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }
  // fetch preserves the existing streaming HTTP contract without buffering SSE through RPC.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET') {
      switch (path) {
        case '/api/health':
          return json({ ok: true, synthetic: true, applications: 240 });
        case '/api/state':
          return json(this.simulation.state());
        case '/api/stream':
          return this.stream();
        case '/api/apps':
          return json(this.simulation.apps);
        case '/api/incidents':
          return json(this.simulation.incidents);
        case '/api/teams/messages':
          return json(this.simulation.messages);
        case '/api/servicenow/cmdb':
          return json(this.simulation.cmdb());
        case '/api/confluence/runbooks':
          return json(this.simulation.runbooks());
        case '/api/logs': {
          let rows = this.simulation.logs;
          for (const field of ['source', 'severity', 'appId', 'id'] as const)
            if (url.searchParams.has(field))
              rows = rows.filter((row) => row[field] === url.searchParams.get(field));
          const query = url.searchParams.get('q')?.toLowerCase();
          if (query) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
          const limit = Number(url.searchParams.get('limit') ?? 300);
          return json(
            rows.slice(0, Number.isFinite(limit) ? Math.max(0, Math.min(300, limit)) : 300),
          );
        }
      }
    }
    if (request.method === 'POST' && ['/api/control', '/api/messages'].includes(path)) {
      if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
        return json({ error: 'Cross-origin mutations are not allowed.' }, 403);
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 16384) {
            await reader.cancel();
            return json({ error: 'Request body too large.' }, 413);
          }
          chunks.push(part.value);
        }
      let input: unknown;
      try {
        input = JSON.parse(
          new TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))) || '{}',
        );
      } catch {
        return json({ error: 'Invalid JSON body.' }, 400);
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return json({ error: 'Expected a JSON object.' }, 400);
      const previous = this.simulation.snapshot();
      try {
        if (path === '/api/control') this.simulation.control(input as ControlInput);
        else this.simulation.sendMessage((input as { text: string }).text);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400);
      }
      try {
        this.persist();
      } catch (error) {
        this.simulation.restore(previous);
        throw error;
      }
      this.emit();
      return json(this.simulation.state());
    }
    return json({ error: 'API route not found.' }, 404);
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health')
      return json({ ok: true, synthetic: true, applications: 240 });
    const shared = url.searchParams.get('room');
    if (shared && !uuid.test(shared)) return json({ error: 'Room must be a UUID.' }, 400);
    const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)incident_room=([^;]+)/)?.[1];
    const room = shared || (cookie && uuid.test(cookie) ? cookie : crypto.randomUUID());
    const response = url.pathname.startsWith('/api/')
      ? await env.INCIDENT_ROOMS.getByName(room).fetch(request)
      : await env.ASSETS.fetch(request);
    const result = new Response(response.body, response);
    if (room !== cookie)
      result.headers.set(
        'Set-Cookie',
        `incident_room=${room}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${url.protocol === 'https:' ? '; Secure' : ''}`,
      );
    result.headers.set('X-Incident-Room', room);
    result.headers.set('X-Content-Type-Options', 'nosniff');
    if (room !== cookie || url.pathname.startsWith('/api/'))
      result.headers.set('Cache-Control', 'no-store');
    return result;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
