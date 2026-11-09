// biome-ignore-all lint/suspicious/noTemplateCurlyInString: generated source code contains literal ${...} placeholders
import { type Knobs, lines, type RepoContext, type UpstreamInfo } from './context';

type Files = Record<string, string>;

function packageJson(ctx: RepoContext, k: Knobs): string {
  const pkg = {
    name: `@keybank/${ctx.repo.name}`,
    version: k.version,
    private: true,
    description: ctx.repo.description,
    type: 'module',
    main: 'dist/index.js',
    engines: { node: '>=20' },
    scripts: {
      build: 'tsc -p tsconfig.json',
      start: 'node dist/index.js',
      dev: 'tsx watch src/index.ts',
      lint: 'eslint . --max-warnings=0',
      test: 'vitest run',
    },
    dependencies: {
      fastify: `^${k.deps.fastify}`,
      pino: `^${k.deps.pino}`,
      zod: `^${k.deps.zod}`,
      ...(k.cacheTtlSec > 0 ? { 'lru-cache': '^10.4.3' } : {}),
    },
    devDependencies: {
      '@types/node': '^20.17.10',
      eslint: '^9.17.0',
      tsx: `^${k.deps.tsx}`,
      typescript: `^${k.deps.typescript}`,
      vitest: `^${k.deps.vitest}`,
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      sourceMap: true,
    },
    include: ['src'],
  },
  null,
  2,
)}\n`;

function config(ctx: RepoContext, k: Knobs): string {
  return lines(
    '/** Runtime configuration. Every value can be overridden with an environment variable. */',
    'const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback);',
    '',
    'export interface UpstreamConfig {',
    '  baseUrl: string;',
    '  connectTimeoutMs: number;',
    '  readTimeoutMs: number;',
    '  retries: number;',
    '}',
    '',
    'export const config = {',
    '  port: num(process.env.PORT, 8080),',
    `  serviceName: '${ctx.repo.name}',`,
    `  logLevel: process.env.LOG_LEVEL ?? '${k.logLevel.toLowerCase()}',`,
    `  maxPageSize: num(process.env.MAX_PAGE_SIZE, ${k.maxPageSize}),`,
    `  cacheTtlSeconds: num(process.env.CACHE_TTL_SECONDS, ${k.cacheTtlSec}),`,
    `  maxSockets: num(process.env.HTTP_MAX_SOCKETS, ${k.poolSize}),`,
    '  upstreams: {',
    ...ctx.upstreams.flatMap((u) => {
      const t = k.timeouts[u.tla]!;
      return [
        `    ${u.lower}: {`,
        `      baseUrl: process.env.${u.envVar} ?? '${u.baseUrl}',`,
        `      connectTimeoutMs: num(process.env.${u.tla}_CONNECT_TIMEOUT_MS, ${t.connectMs}),`,
        `      readTimeoutMs: num(process.env.${u.tla}_READ_TIMEOUT_MS, ${t.readMs}),`,
        `      retries: ${t.retries},`,
        '    },',
      ];
    }),
    '  } satisfies Record<string, UpstreamConfig>,',
    '};',
    '',
  );
}

function httpLib(k: Knobs): string {
  return lines(
    "import { randomUUID } from 'node:crypto';",
    "import type { UpstreamConfig } from '../config.js';",
    "import { logger } from './logger.js';",
    '',
    'export class UpstreamError extends Error {',
    '  constructor(',
    '    readonly upstream: string,',
    '    readonly status: number,',
    '    message: string,',
    '  ) {',
    '    super(message);',
    '  }',
    '}',
    '',
    'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));',
    '',
    '/** JSON request to an upstream with a read timeout' +
      (k.features.retryOnTimeout ? ' and retries on timeouts/5xx.' : '.') +
      ' */',
    'export async function request<T>(',
    '  name: string,',
    '  upstream: UpstreamConfig,',
    '  path: string,',
    "  init: { method?: 'GET' | 'POST'; body?: unknown; requestId?: string } = {},",
    '): Promise<T> {',
    k.features.retryOnTimeout
      ? '  const attempts = upstream.retries + 1;'
      : '  const attempts = 1;',
    '  let lastError: unknown;',
    '  for (let attempt = 1; attempt <= attempts; attempt++) {',
    '    const started = Date.now();',
    '    try {',
    '      const res = await fetch(`${upstream.baseUrl}${path}`, {',
    "        method: init.method ?? 'GET',",
    '        headers: {',
    "          'content-type': 'application/json',",
    k.features.requestIdHeader && "          'x-request-id': init.requestId ?? randomUUID(),",
    '        },',
    '        body: init.body === undefined ? undefined : JSON.stringify(init.body),',
    '        signal: AbortSignal.timeout(upstream.readTimeoutMs),',
    '      });',
    k.features.clientMetrics &&
      "      logger.debug({ upstream: name, status: res.status, ms: Date.now() - started }, 'upstream call');",
    '      if (res.status >= 500) throw new UpstreamError(name, res.status, `${name} returned ${res.status}`);',
    '      if (!res.ok) throw new UpstreamError(name, res.status, `${name} rejected the request (${res.status})`);',
    '      return (await res.json()) as T;',
    '    } catch (err) {',
    '      lastError = err;',
    '      const retryable = !(err instanceof UpstreamError) || err.status >= 500;',
    "      logger.warn({ upstream: name, attempt, ms: Date.now() - started, err: String(err) }, 'upstream call failed');",
    '      if (!retryable || attempt === attempts) break;',
    '      await sleep(100 * 2 ** attempt);',
    '    }',
    '  }',
    '  throw lastError;',
    '}',
    '',
  );
}

const LOGGER = lines(
  "import pino from 'pino';",
  "import { config } from '../config.js';",
  '',
  'export const logger = pino({',
  '  level: config.logLevel,',
  '  base: { service: config.serviceName },',
  '  messageKey: "message",',
  '  formatters: { level: (label) => ({ severity: label.toUpperCase() }) },',
  '});',
  '',
);

function clientFile(u: UpstreamInfo): string {
  const op = u.op;
  const get = op.verb === 'GET';
  return lines(
    "import { config } from '../config.js';",
    "import { request } from '../lib/http.js';",
    '',
    `/** ${u.appName} (${u.tla}) — service \`${u.service}\`. */`,
    `export interface ${op.model} {`,
    '  id: string;',
    '  status: string;',
    '  [key: string]: unknown;',
    '}',
    '',
    `/** ${op.summary}. */`,
    get
      ? `export function ${op.method}(${op.arg}: string, requestId?: string): Promise<${op.model}> {`
      : `export function ${op.method}(${op.arg}: Record<string, unknown>, requestId?: string): Promise<${op.model}> {`,
    get
      ? `  return request<${op.model}>('${u.tla}', config.upstreams.${u.lower}, \`${op.path.replace('{id}', `\${encodeURIComponent(${op.arg})}`)}\`, { requestId });`
      : `  return request<${op.model}>('${u.tla}', config.upstreams.${u.lower}, '${op.path}', { method: 'POST', body: ${op.arg}, requestId });`,
    '}',
    '',
  );
}

function serviceFile(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  const ups = ctx.upstreams;
  const getArgs = ups.filter((u) => u.op.verb === 'GET').map((u) => u.op.arg);
  return lines(
    "import { randomUUID } from 'node:crypto';",
    k.cacheTtlSec > 0 && "import { LRUCache } from 'lru-cache';",
    k.cacheTtlSec > 0 && "import { config } from '../config.js';",
    ...ups.map((u) => `import { ${u.op.method} } from '../clients/${u.lower}.js';`),
    "import { logger } from '../lib/logger.js';",
    '',
    `export interface ${r.pascal} {`,
    '  id: string;',
    '  reference: string;',
    '  status: string;',
    ctx.amountField && '  amount: number;',
    '  createdAt: string;',
    '}',
    '',
    `export interface Create${r.pascal}Input {`,
    '  reference: string;',
    ...getArgs.map((a) => `  ${a}: string;`),
    ctx.amountField && '  amount: number;',
    '}',
    '',
    `const store = new Map<string, ${r.pascal}>();`,
    k.cacheTtlSec > 0 &&
      `const cache = new LRUCache<string, ${r.pascal}>({ max: 10_000, ttl: config.cacheTtlSeconds * 1000 });`,
    '',
    `export function get${r.pascal}(id: string): ${r.pascal} | undefined {`,
    k.cacheTtlSec > 0 && '  const cached = cache.get(id);',
    k.cacheTtlSec > 0 && '  if (cached) return cached;',
    '  const found = store.get(id);',
    k.cacheTtlSec > 0 && '  if (found) cache.set(id, found);',
    '  return found;',
    '}',
    '',
    `export function list${r.pascal}s(page: number, size: number): ${r.pascal}[] {`,
    '  return [...store.values()].slice(page * size, (page + 1) * size);',
    '}',
    '',
    `export async function create${r.pascal}(input: Create${r.pascal}Input, requestId?: string): Promise<${r.pascal}> {`,
    ...ups.map((u) => {
      const v = u.op.model[0]!.toLowerCase() + u.op.model.slice(1);
      return u.op.verb === 'GET'
        ? `  const ${v} = await ${u.op.method}(input.${u.op.arg}, requestId);`
        : `  const ${v} = await ${u.op.method}({ reference: input.reference, source: '${ctx.repo.name}' }, requestId);`;
    }),
    `  const created: ${r.pascal} = {`,
    '    id: randomUUID(),',
    '    reference: input.reference,',
    "    status: 'ACCEPTED',",
    ctx.amountField && '    amount: input.amount,',
    '    createdAt: new Date().toISOString(),',
    '  };',
    '  store.set(created.id, created);',
    `  logger.info({ id: created.id, reference: input.reference }, '${r.title.toLowerCase()} created');`,
    '  return created;',
    '}',
    '',
  );
}

function routeFile(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  const ups = ctx.upstreams;
  const getArgs = ups.filter((u) => u.op.verb === 'GET').map((u) => u.op.arg);
  return lines(
    "import type { FastifyInstance } from 'fastify';",
    "import { z } from 'zod';",
    "import { config } from '../config.js';",
    "import { UpstreamError } from '../lib/http.js';",
    `import { create${r.pascal}, get${r.pascal}, list${r.pascal}s } from '../services/${r.kebab}.js';`,
    '',
    'const createSchema = z.object({',
    '  reference: z.string().min(1),',
    ...getArgs.map((a) => `  ${a}: z.string().min(1),`),
    ctx.amountField && '  amount: z.number().positive(),',
    '});',
    '',
    `export async function ${r.camel}Routes(app: FastifyInstance) {`,
    `  app.get('/api/v1/${r.pluralKebab}', async (req, reply) => {`,
    '    const query = req.query as { page?: string; pageSize?: string };',
    '    const page = Number(query.page ?? 0);',
    '    const pageSize = Number(query.pageSize ?? 50);',
    k.features.inputValidation &&
      '    if (!(pageSize >= 1 && pageSize <= config.maxPageSize)) return reply.code(400).send({ error: `pageSize must be between 1 and ${config.maxPageSize}` });',
    k.features.inputValidation
      ? `    return list${r.pascal}s(page, pageSize);`
      : `    return list${r.pascal}s(page, Math.min(pageSize, config.maxPageSize));`,
    '  });',
    '',
    `  app.get('/api/v1/${r.pluralKebab}/:id', async (req, reply) => {`,
    '    const { id } = req.params as { id: string };',
    `    const found = get${r.pascal}(id);`,
    `    if (!found) return reply.code(404).send({ error: \`${r.title} \${id} not found\` });`,
    '    return found;',
    '  });',
    '',
    `  app.post('/api/v1/${r.pluralKebab}', async (req, reply) => {`,
    '    const parsed = createSchema.safeParse(req.body);',
    '    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });',
    '    try {',
    `      const created = await create${r.pascal}(parsed.data, req.id);`,
    '      return reply.code(201).send(created);',
    '    } catch (err) {',
    "      if (err instanceof UpstreamError || (err as Error).name === 'TimeoutError') {",
    "        req.log.warn({ err }, 'upstream failure');",
    k.features.problemJson
      ? "        return reply.code(503).type('application/problem+json').send({ title: 'Upstream unavailable', status: 503, detail: String((err as Error).message) });"
      : "        return reply.code(503).send({ error: 'upstream_unavailable' });",
    '      }',
    '      throw err;',
    '    }',
    '  });',
    '}',
    '',
  );
}

function healthRoute(ctx: RepoContext): string {
  return lines(
    "import type { FastifyInstance } from 'fastify';",
    '',
    'export async function healthRoutes(app: FastifyInstance) {',
    "  app.get('/health/live', async () => ({ status: 'UP' }));",
    `  app.get('/health/ready', async () => ({ status: 'UP', service: '${ctx.repo.name}' }));`,
    '}',
    '',
  );
}

function indexFile(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    "import Fastify from 'fastify';",
    "import { config } from './config.js';",
    "import { logger } from './lib/logger.js';",
    "import { healthRoutes } from './routes/health.js';",
    `import { ${r.camel}Routes } from './routes/${r.kebab}.js';`,
    '',
    'const app = Fastify({',
    '  loggerInstance: logger,',
    "  requestIdHeader: 'x-request-id',",
    '  disableRequestLogging: false,',
    '});',
    '',
    'await app.register(healthRoutes);',
    `await app.register(${r.camel}Routes);`,
    '',
    "await app.listen({ port: config.port, host: '0.0.0.0' });",
    `logger.info({ port: config.port }, '${ctx.repo.name} started');`,
    '',
    "for (const signal of ['SIGTERM', 'SIGINT'] as const) {",
    '  process.once(signal, async () => {',
    '    await app.close();',
    '    process.exit(0);',
    '  });',
    '}',
    '',
  );
}

function jobFile(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    `import { list${r.pascal}s } from '../services/${r.kebab}.js';`,
    "import { logger } from '../lib/logger.js';",
    '',
    `/** Nightly ${r.title.toLowerCase()} batch (scheduled by a Kubernetes CronJob). */`,
    'export async function run(chunkSize = 500): Promise<number> {',
    '  let processed = 0;',
    '  for (let page = 0; ; page++) {',
    `    const batch = list${r.pascal}s(page, chunkSize);`,
    '    if (batch.length === 0) break;',
    '    processed += batch.length;',
    '  }',
    `  logger.info({ processed }, '${r.kebab} job finished');`,
    '  return processed;',
    '}',
    '',
  );
}

function routeTest(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    "import { describe, expect, it } from 'vitest';",
    `import { get${r.pascal}, list${r.pascal}s } from '../src/services/${r.kebab}.js';`,
    '',
    `describe('${r.kebab} service', () => {`,
    "  it('returns undefined for unknown ids', () => {",
    `    expect(get${r.pascal}('missing')).toBeUndefined();`,
    '  });',
    '',
    "  it('pages through records', () => {",
    `    expect(list${r.pascal}s(0, 10)).toEqual([]);`,
    '  });',
    '});',
    '',
  );
}

const HTTP_TEST = lines(
  "import { afterEach, describe, expect, it, vi } from 'vitest';",
  "import { request, UpstreamError } from '../src/lib/http.js';",
  '',
  "const upstream = { baseUrl: 'http://upstream.test', connectTimeoutMs: 100, readTimeoutMs: 100, retries: 1 };",
  '',
  "describe('request', () => {",
  '  afterEach(() => vi.restoreAllMocks());',
  '',
  "  it('throws UpstreamError on 4xx', async () => {",
  "    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));",
  "    await expect(request('TST', upstream, '/x')).rejects.toBeInstanceOf(UpstreamError);",
  '  });',
  '',
  "  it('parses JSON responses', async () => {",
  '    vi.spyOn(globalThis, \'fetch\').mockResolvedValue(new Response(\'{"id":"1"}\', { status: 200 }));',
  "    await expect(request('TST', upstream, '/x')).resolves.toEqual({ id: '1' });",
  '  });',
  '});',
  '',
);

const EXTRA_TESTS: Record<string, (ctx: RepoContext) => [string, string] | null> = {
  validation: (ctx) => [
    'test/validation.test.ts',
    lines(
      "import Fastify from 'fastify';",
      "import { describe, expect, it } from 'vitest';",
      `import { ${ctx.resource.camel}Routes } from '../src/routes/${ctx.resource.kebab}.js';`,
      '',
      "describe('input validation', () => {",
      "  it('rejects a create without reference', async () => {",
      '    const app = Fastify();',
      `    await app.register(${ctx.resource.camel}Routes);`,
      `    const res = await app.inject({ method: 'POST', url: '/api/v1/${ctx.resource.pluralKebab}', payload: {} });`,
      '    expect(res.statusCode).toBe(400);',
      '  });',
      '});',
      '',
    ),
  ],
  'client-timeouts': (ctx) => {
    const u = ctx.upstreams[0];
    if (!u) return null;
    return [
      `test/${u.lower}-client.test.ts`,
      lines(
        "import { afterEach, describe, expect, it, vi } from 'vitest';",
        `import { ${u.op.method} } from '../src/clients/${u.lower}.js';`,
        '',
        `describe('${u.tla} client', () => {`,
        '  afterEach(() => vi.restoreAllMocks());',
        '',
        "  it('aborts slow responses', async () => {",
        "    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));",
        u.op.verb === 'GET'
          ? `    await expect(${u.op.method}('1')).rejects.toThrow('timeout');`
          : `    await expect(${u.op.method}({})).rejects.toThrow('timeout');`,
        '  });',
        '});',
        '',
      ),
    ];
  },
  'error-mapping': (ctx) => [
    'test/errors.test.ts',
    lines(
      "import { describe, expect, it } from 'vitest';",
      "import { UpstreamError } from '../src/lib/http.js';",
      '',
      "describe('UpstreamError', () => {",
      "  it('keeps the upstream name and status', () => {",
      `    const err = new UpstreamError('${ctx.upstreams[0]?.tla ?? 'TST'}', 503, 'unavailable');`,
      '    expect(err.status).toBe(503);',
      '  });',
      '});',
      '',
    ),
  ],
  serialization: () => [
    'test/config.test.ts',
    lines(
      "import { describe, expect, it } from 'vitest';",
      "import { config } from '../src/config.js';",
      '',
      "describe('config', () => {",
      "  it('has sane defaults', () => {",
      '    expect(config.port).toBe(8080);',
      '    expect(config.maxPageSize).toBeGreaterThan(0);',
      '  });',
      '});',
      '',
    ),
  ],
};

export const NODE_EXTRA_TESTS = Object.keys(EXTRA_TESTS);

export function renderNode(ctx: RepoContext, k: Knobs): Files {
  const r = ctx.resource;
  const files: Files = {
    'package.json': packageJson(ctx, k),
    'tsconfig.json': TSCONFIG,
    'src/config.ts': config(ctx, k),
    'src/lib/http.ts': httpLib(k),
    'src/lib/logger.ts': LOGGER,
    [`src/services/${r.kebab}.ts`]: serviceFile(ctx, k),
  };
  for (const u of ctx.upstreams) files[`src/clients/${u.lower}.ts`] = clientFile(u);
  if (ctx.repo.kind === 'batch') {
    files[`src/jobs/${r.kebab}-job.ts`] = jobFile(ctx);
    files['src/index.ts'] = lines(
      `import { run } from './jobs/${r.kebab}-job.js';`,
      '',
      'const processed = await run(Number(process.env.CHUNK_SIZE ?? 500));',
      'process.exit(processed >= 0 ? 0 : 1);',
      '',
    );
  } else {
    files['src/index.ts'] = indexFile(ctx);
    files['src/routes/health.ts'] = healthRoute(ctx);
    files[`src/routes/${r.kebab}.ts`] = routeFile(ctx, k);
  }
  files[`test/${r.kebab}.test.ts`] = routeTest(ctx);
  files['test/http.test.ts'] = HTTP_TEST;
  for (const key of k.extraTests) {
    const out = EXTRA_TESTS[key]?.(ctx);
    if (out) files[out[0]] = out[1];
  }
  return files;
}
