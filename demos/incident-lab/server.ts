import http, { type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation, type ControlInput } from './simulation.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'dist/client');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
export function createServer({ simulation = new Simulation(), ticking = true } = {}) {
  const clients = new Set<ServerResponse>();
  const emit = () => {
    const payload = `event: state\ndata: ${JSON.stringify(simulation.state())}\n\n`;
    for (const client of clients) {
      if (!client.writableEnded) client.write(payload);
    }
  };
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (req.method === 'GET') {
          if (path === '/api/health')
            return json(res, { ok: true, synthetic: true, applications: simulation.apps.length });
          if (path === '/api/state') return json(res, simulation.state());
          if (path === '/api/stream') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            });
            res.write(`event: state\ndata: ${JSON.stringify(simulation.state())}\n\n`);
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
          }
          if (path === '/api/apps') return json(res, simulation.apps);
          if (path === '/api/incidents') return json(res, simulation.incidents);
          if (path === '/api/teams/messages') return json(res, simulation.messages);
          if (path === '/api/servicenow/cmdb') return json(res, simulation.cmdb());
          if (path === '/api/confluence/runbooks') return json(res, simulation.runbooks());
          if (path === '/api/logs') {
            let rows = simulation.logs;
            for (const field of ['source', 'severity', 'appId', 'id'] as const)
              if (url.searchParams.has(field))
                rows = rows.filter((row) => row[field] === url.searchParams.get(field));
            const q = url.searchParams.get('q')?.toLowerCase();
            if (q) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
            const limit = Number(url.searchParams.get('limit') || 300);
            return json(
              res,
              rows.slice(0, Number.isFinite(limit) ? Math.max(0, Math.min(300, limit)) : 300),
            );
          }
        }
        if (req.method === 'POST' && ['/api/control', '/api/messages'].includes(path)) {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host)
            return json(res, { error: 'Cross-origin mutations are not allowed.' }, 403);
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 16384)
              return json(res, { error: 'Request body too large.' }, 413);
          }
          let input;
          try {
            input = JSON.parse(body || '{}');
          } catch {
            return json(res, { error: 'Invalid JSON body.' }, 400);
          }
          if (!input || typeof input !== 'object' || Array.isArray(input))
            return json(res, { error: 'Expected a JSON object.' }, 400);
          try {
            const result =
              path === '/api/control'
                ? simulation.control(input as ControlInput)
                : simulation.sendMessage(input.text);
            json(res, result);
            emit();
            return;
          } catch (error) {
            return json(
              res,
              { error: error instanceof Error ? error.message : 'Invalid request.' },
              400,
            );
          }
        }
        return json(res, { error: 'API route not found.' }, 404);
      }
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
        res.writeHead(405);
        return res.end('Method not allowed');
      }
      let decoded;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        res.writeHead(400);
        return res.end('Invalid path');
      }
      let filename = resolve(ROOT, `.${decoded}`);
      if (filename !== ROOT && !filename.startsWith(ROOT + sep)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      try {
        if ((await stat(filename)).isDirectory()) filename = resolve(filename, 'index.html');
        await stat(filename);
      } catch {
        if (!extname(decoded)) filename = resolve(ROOT, 'index.html');
        else {
          res.writeHead(404);
          return res.end('Not found');
        }
      }
      const content = await readFile(filename);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filename)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, { error: 'Request failed.' }, 500);
      else res.end();
    }
  });
  const timer = ticking
    ? setInterval(() => {
        simulation.tick();
        emit();
      }, 1000)
    : null;
  timer?.unref();
  server.on('close', () => {
    if (timer) clearInterval(timer);
    for (const client of clients) client.end();
  });
  return { server, simulation, emit };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4311);
  const { server } = createServer();
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `\n  Relay incident lab\n  Local: http://127.0.0.1:${port}\n  240 synthetic applications · no external services\n`,
    ),
  );
  server.on('error', (error) => {
    console.error(
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Run with PORT=4312 to choose another.`
        : error.message,
    );
    process.exitCode = 1;
  });
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
