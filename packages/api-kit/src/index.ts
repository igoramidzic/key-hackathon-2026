import type { Health, Page } from '@sim/contracts';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type ZodType, z } from 'zod';

/** Throw from any handler to return `{ error }` with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unprocessable = (message: string) => new HttpError(422, message);

export interface ApiOptions {
  /** e.g. `servicenow-api` */
  service: string;
  /** Counters shown on /health and in the control panel. */
  stats?: () => Record<string, number>;
}

/**
 * Hono app with CORS, JSON errors and `GET /health`. Add routes, then call `startApi`.
 * Every system also registers `POST /admin/reset`.
 */
export function createApi({ service, stats }: ApiOptions) {
  const app = new Hono();
  const startedAt = new Date().toISOString();
  app.use('*', cors());
  app.get('/health', (c) =>
    c.json<Health>({ status: 'ok', service, started_at: startedAt, stats: stats?.() }),
  );
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) {
      return c.json({ error: formatZodError(err), issues: err.issues }, 400);
    }
    console.error(`[${service}]`, err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404));
  return app;
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ');
}

/** Parses and validates a JSON body. Throws a 400 with readable messages. */
export async function parseBody<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw badRequest(formatZodError(result.error));
  return result.data;
}

/** Parses query params (all strings; use z.coerce for numbers). Throws a 400 on failure. */
export function parseQuery<S extends ZodType>(c: Context, schema: S): z.infer<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw badRequest(formatZodError(result.error));
  return result.data;
}

/** Standard `limit` + `cursor` query params. */
export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(500).default(25),
  cursor: z.string().optional(),
};

/** Offset cursor helpers. Cursors are opaque to clients. */
export const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const match = decoded.match(/^o:(\d+)$/);
  if (!match) throw badRequest('Invalid cursor');
  return Number(match[1]);
}

/** Slices an in-memory list into a page. */
export function paginate<T>(items: T[], opts: { limit: number; cursor?: string }): Page<T> {
  const offset = decodeCursor(opts.cursor);
  const slice = items.slice(offset, offset + opts.limit);
  const next = offset + slice.length;
  return {
    items: slice,
    next_cursor: next < items.length ? encodeCursor(next) : null,
    total: items.length,
  };
}

/** Comma-separated list param → array (`a,b` → ['a','b']). */
export const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

/** Parses relative times like `15m`, `2h`, `7d` or ISO strings into a Date. */
export function parseTime(value: string | undefined, now = new Date()): Date | undefined {
  if (!value) return undefined;
  const rel = value.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return new Date(now.getTime() - n * ms);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`Invalid time: ${value}`);
  return date;
}
