import type { App, Stack } from '@sim/world';
import type { LogContext, LogTemplate, RenderedLog } from './types';
import { abbreviateLogger, latency, reqId, shortTrace, tomcatThread, tpl } from './util';

/** Shared builders for the three runtime log styles. */

type Http = { method: string; url: string; status: number; latencySec: number };

const http = (h?: Http): RenderedLog['httpRequest'] =>
  h && {
    requestMethod: h.method,
    requestUrl: h.url,
    status: h.status,
    latencySec: h.latencySec,
  };

/** Spring Boot structured logging (logstash JSON): abbreviated logger, Tomcat thread, MDC trace. */
export function javaLog(
  ctx: LogContext,
  o: {
    logger: string;
    message: string;
    thread?: string;
    error?: RenderedLog['error'];
    http?: Http;
    fields?: Record<string, unknown>;
  },
): RenderedLog {
  return {
    message: o.message,
    logger: abbreviateLogger(o.logger),
    thread: o.thread ?? tomcatThread(ctx),
    error: o.error,
    httpRequest: http(o.http),
    fields: { traceId: shortTrace(ctx), ...o.fields },
  };
}

/** pino (Fastify) JSON: request id bound on the child logger, `err` serialized. */
export function nodeLog(
  ctx: LogContext,
  o: {
    message: string;
    error?: RenderedLog['error'];
    http?: Http;
    fields?: Record<string, unknown>;
  },
): RenderedLog {
  return {
    message: o.message,
    error: o.error,
    httpRequest: http(o.http),
    fields: { reqId: reqId(ctx), ...o.fields },
  };
}

/** python-json-logger with the stdlib logger name. */
export function pyLog(
  ctx: LogContext,
  o: {
    logger: string;
    message: string;
    error?: RenderedLog['error'];
    http?: Http;
    fields?: Record<string, unknown>;
  },
): RenderedLog {
  return {
    message: o.message,
    logger: o.logger,
    thread: 'MainThread',
    error: o.error,
    httpRequest: http(o.http),
    fields: { taskName: `Task-${ctx.rng.int(100, 99_999)}`, ...o.fields },
  };
}

/** Internal base URL of an app's primary service. */
export function internalUrl(app: App, path: string): string {
  return `https://${app.runtime.service}.internal.keybank.example${path}`;
}

/** Java package segment used by the GitLab template generator for an app. */
export function javaPackage(app: App): string {
  return `com.keybank.${app.tla.toLowerCase()}`;
}

/** Python package dir used by the GitLab template generator for an app. */
export function pyPackage(app: App): string {
  return app.runtime.service.replace(/-/g, '_');
}

/**
 * Per-stack generic templates for the long tail of generated apps. `java`, `node` and `python`
 * build the line for that stack; other stacks emit nothing.
 */
export function perStack(builders: {
  java: (app: App) => LogTemplate[];
  node: (app: App) => LogTemplate[];
  python: (app: App) => LogTemplate[];
}): (app: App, stack: Stack) => LogTemplate[] {
  return (app, stack) => {
    if (stack === 'java-spring') return builders.java(app);
    if (stack === 'node-ts') return builders.node(app);
    if (stack === 'python') return builders.python(app);
    return [];
  };
}

/** WARN line a Spring resource server writes when a bearer token is rejected as expired. */
export function springJwtExpired(o: {
  logger: string;
  baseUrl: string;
  requests: readonly (readonly [string, string])[];
  weight?: number;
  userAgents?: readonly string[];
}): LogTemplate {
  return tpl(
    'WARNING',
    (ctx) => {
      const [method, path] = ctx.rng.pick(o.requests);
      const resolved = path
        .replace('{customerId}', ctx.customerId())
        .replace('{account}', ctx.account());
      const expiredAt = new Date(ctx.now.getTime() - ctx.rng.int(62, 540) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      return javaLog(ctx, {
        logger: o.logger,
        message: `Rejected bearer token: ${method} ${resolved} -> 401 invalid_token: An error occurred while attempting to decode the Jwt: Jwt expired at ${expiredAt}`,
        http: {
          method,
          url: `${o.baseUrl}${resolved}`,
          status: 401,
          latencySec: latency(ctx, 0.001, 0.006),
        },
        fields: o.userAgents ? { userAgent: ctx.rng.pick(o.userAgents) } : undefined,
      });
    },
    o.weight ?? 1,
  );
}
