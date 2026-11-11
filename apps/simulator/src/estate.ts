import type { LogEntryInput, LogError, Severity } from '@sim/contracts/logs';
import type { RenderedLog } from '@sim/scenarios';
import { type App, getWorld, groupPathForTla, Rng, type Stack, shaFor } from '@sim/world';
import { spanId, traceId } from './values';

/** k8s pod-template-hash alphabet (no vowels, no confusable digits). */
const K8S_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';

function k8sId(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += K8S_ALPHABET[rng.int(0, K8S_ALPHABET.length - 1)];
  return out;
}

/** One running workload (k8s deployment) of an app. */
export interface ServiceRuntime {
  app: App;
  service: string;
  stack: Stack;
  pods: string[];
  semver: [number, number, number];
  /** Short sha of the deployed revision. */
  revision: string;
  /** `labels.version` on every log line, e.g. `3.12.4-9f2c1ab`. */
  version: string;
  deployCount: number;
}

/** A line before it is wrapped into a GCP LogEntry. */
export interface LineSpec {
  severity: Severity;
  message: string;
  logger?: string;
  thread?: string;
  error?: LogError;
  fields?: Record<string, unknown>;
  httpRequest?: {
    requestMethod: string;
    requestUrl: string;
    status: number;
    latencySec: number;
    userAgent?: string;
    remoteIp?: string;
  };
  /** Attach a trace id (default: only when the line has an httpRequest). */
  trace?: boolean | string;
  pod?: string;
}

export function lineFromRendered(severity: Severity, r: RenderedLog): LineSpec {
  return {
    severity,
    message: r.message,
    logger: r.logger,
    thread: r.thread,
    error: r.error,
    fields: r.fields,
    httpRequest: r.httpRequest,
    trace: true,
  };
}

/** Stack conventions for loggers, threads and startup lines. */
export const stackStyle = {
  javaPackage: (tla: string) => `c.k.${tla.toLowerCase()}`,
  defaultThread(stack: Stack, rng: Rng): string | undefined {
    if (stack === 'java-spring') return `http-nio-8080-exec-${rng.int(1, 64)}`;
    if (stack === 'python')
      return rng.chance(0.7) ? 'MainThread' : `ThreadPoolExecutor-0_${rng.int(0, 7)}`;
    return undefined;
  },
};

/**
 * Pods, versions and revisions for every service that logs. Deterministic from `seed`; rebuilt
 * on reset. Deploys bump the patch version, set the revision and roll the pods.
 */
export class Estate {
  private readonly services = new Map<string, ServiceRuntime>();
  private readonly rng: Rng;

  constructor(private readonly seed = 'estate') {
    this.rng = new Rng(`${seed}:entries`);
  }

  get(app: App, service = app.runtime.service): ServiceRuntime {
    const key = `${app.tla}/${service}`;
    let rt = this.services.get(key);
    if (!rt) {
      const rng = new Rng(`${this.seed}:${key}`);
      const replicas = app.tier === 1 ? rng.int(3, 4) : rng.int(2, 3);
      const repo = getWorld().reposByPath.get(`${groupPathForTla(app.tla)}/${service}`);
      const semver: [number, number, number] = [rng.int(1, 5), rng.int(0, 30), rng.int(0, 15)];
      const revision = shaFor(`${this.seed}:baseline:${key}`).slice(0, 7);
      rt = {
        app,
        service,
        stack:
          repo?.stack === 'react-web' || repo?.stack === 'terraform'
            ? app.stack
            : (repo?.stack ?? app.stack),
        pods: [],
        semver,
        revision,
        version: '',
        deployCount: 0,
      };
      rt.version = versionLabel(rt);
      rt.pods = rollPods(rng, service, replicas);
      this.services.set(key, rt);
    }
    return rt;
  }

  /** Records a rollout of `sha`. Returns the runtime before and after. */
  deploy(
    app: App,
    service: string,
    sha: string,
  ): { before: ServiceRuntime; after: ServiceRuntime } {
    const rt = this.get(app, service);
    const before = {
      ...rt,
      pods: [...rt.pods],
      semver: [...rt.semver] as [number, number, number],
    };
    rt.deployCount++;
    rt.semver = [rt.semver[0], rt.semver[1], rt.semver[2] + 1];
    rt.revision = sha.slice(0, 7);
    rt.version = versionLabel(rt);
    rt.pods = rollPods(
      new Rng(`${this.seed}:${app.tla}/${service}:${sha}`),
      service,
      rt.pods.length,
    );
    return { before, after: rt };
  }

  /** Wraps a line into a full GCP LogEntry for `rt`. */
  entry(rt: ServiceRuntime, line: LineSpec, timestamp: Date, rng: Rng = this.rng): LogEntryInput {
    const { app } = rt;
    const pod = line.pod ?? rng.pick(rt.pods);
    const thread = line.thread ?? stackStyle.defaultThread(rt.stack, rng);
    const jsonPayload: LogEntryInput['jsonPayload'] = { message: line.message };
    if (line.logger) jsonPayload.logger = line.logger;
    if (thread) jsonPayload.thread = thread;
    if (line.error) jsonPayload.error = line.error;
    if (line.fields) Object.assign(jsonPayload, line.fields);
    const entry: LogEntryInput = {
      logName: `projects/${app.runtime.gcpProject}/logs/stdout`,
      timestamp: timestamp.toISOString(),
      severity: line.severity,
      resource: {
        type: 'k8s_container',
        labels: {
          project_id: app.runtime.gcpProject,
          location: app.runtime.region,
          cluster_name: app.runtime.cluster,
          namespace_name: app.runtime.namespace,
          pod_name: pod,
          container_name: rt.service,
        },
      },
      labels: { app_tla: app.tla, app_name: app.name, env: 'prod', version: rt.version },
      jsonPayload,
    };
    if (line.httpRequest) {
      const h = line.httpRequest;
      entry.httpRequest = {
        requestMethod: h.requestMethod,
        requestUrl: h.requestUrl,
        status: h.status,
        latency: `${Math.max(0, h.latencySec).toFixed(3)}s`,
      };
      if (h.userAgent) entry.httpRequest.userAgent = h.userAgent;
      if (h.remoteIp) entry.httpRequest.remoteIp = h.remoteIp;
    }
    const wantsTrace = line.trace ?? Boolean(line.httpRequest);
    if (wantsTrace) {
      const id = typeof wantsTrace === 'string' ? wantsTrace : traceId(rng);
      entry.trace = `projects/${app.runtime.gcpProject}/traces/${id}`;
      entry.spanId = spanId(rng);
    }
    return entry;
  }

  /**
   * Log lines for a rolling update of `sha` (call after `deploy`). Timestamps spread over the
   * next ~`durationSec` seconds; the caller holds future entries until they are due.
   */
  rolloutLines(
    before: ServiceRuntime,
    after: ServiceRuntime,
    sha: string,
    startMs: number,
    durationSec = 20,
    meta: Record<string, string> = {},
  ): LogEntryInput[] {
    const rng = new Rng(`${this.seed}:rollout:${after.service}:${sha}`);
    const { app } = after;
    const pkg = stackStyle.javaPackage(app.tla);
    const image = `${app.runtime.region}-docker.pkg.dev/${app.runtime.gcpProject}/apps/${after.service}:${sha.slice(0, 7)}`;
    const out: LogEntryInput[] = [];
    const deployFields = {
      revision: after.revision,
      previous_revision: before.revision,
      image,
      commit_sha: sha,
      deployment: after.service,
      ...meta,
    };
    const via = meta.release_id
      ? ` (${meta.release_id}${meta.change_number ? `, ${meta.change_number}` : ''})`
      : '';
    const deployLogger = 'k8s.rollout';
    out.push(
      this.entry(
        after,
        {
          severity: 'INFO',
          message: `Rolling update started: ${after.service} ${before.revision} -> ${after.revision}${via}`,
          logger: deployLogger,
          thread: undefined,
          fields: deployFields,
          pod: after.pods[0],
        },
        new Date(startMs),
        rng,
      ),
    );
    const step = (durationSec * 1000) / (after.pods.length + 1);
    after.pods.forEach((pod, i) => {
      const at = new Date(startMs + step * (i + 0.6) + rng.int(0, 400));
      const bootSec = rng.float(6, 14).toFixed(3);
      let message: string;
      let logger: string;
      let thread: string | undefined;
      if (after.stack === 'java-spring') {
        const name = after.service
          .split('-')
          .map((w) => w[0]!.toUpperCase() + w.slice(1))
          .join('');
        message = `Started ${name}Application in ${bootSec} seconds (process running for ${(Number(bootSec) + 0.9).toFixed(3)})`;
        logger = `${pkg}.${name}Application`;
        thread = 'main';
      } else if (after.stack === 'python') {
        message = 'Application startup complete.';
        logger = 'uvicorn.error';
        thread = 'MainThread';
      } else {
        message = `Server listening at http://0.0.0.0:8080 (version ${after.version})`;
        logger = 'server';
      }
      out.push(this.entry(after, { severity: 'INFO', message, logger, thread, pod }, at, rng));
    });
    out.push(
      this.entry(
        after,
        {
          severity: 'INFO',
          message: `Rolling update complete: ${after.service} revision ${after.revision}`,
          logger: deployLogger,
          fields: { ...deployFields, replicas: after.pods.length },
          pod: after.pods[after.pods.length - 1],
        },
        new Date(startMs + durationSec * 1000),
        rng,
      ),
    );
    return out;
  }
}

function versionLabel(rt: Pick<ServiceRuntime, 'semver' | 'revision'>): string {
  return `${rt.semver.join('.')}-${rt.revision}`;
}

function rollPods(rng: Rng, service: string, replicas: number): string[] {
  const hash = k8sId(rng, 10);
  return Array.from({ length: replicas }, () => `${service}-${hash}-${k8sId(rng, 5)}`);
}
