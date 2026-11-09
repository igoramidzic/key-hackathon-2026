/**
 * Dev helper: ingests realistic log entries into a running logs API.
 *
 *   pnpm --filter @sim/logs-api seed                 # 400 entries over the last 2h + an error spike
 *   pnpm --filter @sim/logs-api seed -- --count 2000
 *   pnpm --filter @sim/logs-api seed -- --live       # then keep emitting ~5 entries/s
 *
 * Not used by the simulator (it produces its own traffic); this only exists to exercise the API,
 * MCP server and UI in isolation.
 */
import { URLS } from '@sim/contracts';
import { createLogsClient, type LogEntryInput, type Severity } from '@sim/contracts/logs';
import { type App, getApp, getWorld, Rng } from '@sim/world';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const api = createLogsClient(process.env.LOGS_API_URL ?? URLS.logs.api);
const rng = new Rng(`seed-logs-${Date.now()}`);
const world = getWorld();
const apps = world.apps.filter((a) => a.emitsLogs).slice(0, 12);

const hex = (n: number) => rng.hex(n);
const account = () => `****${rng.int(1000, 9999)}`;
const customer = () => `C${rng.int(10_000_000, 99_999_999)}`;

const INFO_MESSAGES: ((app: App) => string)[] = [
  () => `Processed request for customer ${customer()} in ${rng.int(12, 240)}ms`,
  () => `Cache hit ratio 0.${rng.int(80, 99)} over last 60s`,
  (a: App) => `Published event ${a.runtime.namespace}.events offset=${rng.int(1e5, 9e5)}`,
  () => `Health check OK (db=UP, cache=UP)`,
  () => `Balance inquiry completed for account ${account()}`,
];
const WARN_MESSAGES: (() => string)[] = [
  () => `Slow query detected: ${rng.int(1200, 4800)}ms SELECT * FROM holds WHERE account_id = ?`,
  () => `Retrying call to auth-token-service (attempt ${rng.int(2, 3)} of 3)`,
  () => `Connection pool usage at ${rng.int(80, 95)}% (active=${rng.int(16, 19)}, max=20)`,
];
const ERROR_MESSAGES: (() => { message: string; type: string; status: number })[] = [
  () => ({
    message: `Upstream call failed: 503 Service Unavailable from customer-profile-api`,
    type: 'org.springframework.web.client.HttpServerErrorException',
    status: 502,
  }),
  () => ({
    message: `Unhandled exception processing request ${hex(16)}`,
    type: 'java.lang.NullPointerException',
    status: 500,
  }),
];

function base(app: App, ts: number, severity: Severity, service = app.runtime.service) {
  return {
    logName: `projects/${app.runtime.gcpProject}/logs/stdout`,
    timestamp: new Date(ts).toISOString(),
    severity,
    resource: {
      type: 'k8s_container' as const,
      labels: {
        project_id: app.runtime.gcpProject,
        location: app.runtime.region,
        cluster_name: app.runtime.cluster,
        namespace_name: app.runtime.namespace,
        pod_name: `${service}-${hex(9)}-${rng.alnum(5)}`,
        container_name: service,
      },
    },
    labels: { app_tla: app.tla, app_name: app.name, env: 'prod' as const, version: '4.12.0' },
    trace: `projects/${app.runtime.gcpProject}/traces/${hex(32)}`,
    spanId: hex(16),
  };
}

function background(ts: number): LogEntryInput {
  const app = rng.pick(apps);
  const severity = rng.weighted<Severity>([
    ['INFO', 80],
    ['DEBUG', 6],
    ['NOTICE', 2],
    ['WARNING', 9],
    ['ERROR', 3],
  ]);
  const method = rng.pick(['GET', 'GET', 'POST', 'PUT']);
  const path = `/api/v1/${app.runtime.service.split('-')[0]}/${rng.int(1000, 9999)}`;
  if (severity === 'ERROR') {
    const err = rng.pick(ERROR_MESSAGES)();
    return {
      ...base(app, ts, severity),
      jsonPayload: {
        message: err.message,
        logger: 'c.k.web.GlobalExceptionHandler',
        error: {
          type: err.type,
          message: err.message,
          stack_trace: `${err.type}: ${err.message}\n\tat com.keybank.${app.tla.toLowerCase()}.Handler.handle(Handler.java:${rng.int(40, 200)})\n\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)`,
        },
      },
      httpRequest: {
        requestMethod: method,
        requestUrl: path,
        status: err.status,
        latency: `${rng.float(0.05, 1.2).toFixed(3)}s`,
      },
    };
  }
  const message = severity === 'WARNING' ? rng.pick(WARN_MESSAGES)() : rng.pick(INFO_MESSAGES)(app);
  const withHttp = severity === 'INFO' && rng.chance(0.4);
  return {
    ...base(app, ts, severity),
    jsonPayload: {
      message,
      logger: `c.k.${app.tla.toLowerCase()}.Service`,
      thread: `http-nio-8080-exec-${rng.int(1, 40)}`,
    },
    ...(withHttp
      ? {
          httpRequest: {
            requestMethod: method,
            requestUrl: path,
            status: rng.pick([200, 200, 200, 201, 204, 404]),
            latency: `${rng.float(0.004, 0.4).toFixed(3)}s`,
          },
        }
      : {}),
  };
}

/** A payments incident: PAY times out calling DEP, DEP's DB pool is exhausted. */
function spike(ts: number): LogEntryInput {
  if (rng.chance(0.55)) {
    const pay = getApp('PAY');
    const ms = rng.pick([3000, 3000, 5000]);
    const message = `Timeout after ${ms}ms calling deposit-accounts-api POST /accounts/${account()}/holds`;
    return {
      ...base(pay, ts, rng.chance(0.1) ? 'CRITICAL' : 'ERROR'),
      jsonPayload: {
        message,
        logger: 'c.k.pay.client.DepositClient',
        error: {
          type: 'java.net.SocketTimeoutException',
          message: 'Read timed out',
          stack_trace:
            'java.net.SocketTimeoutException: Read timed out\n\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(NioSocketImpl.java:278)\n\tat com.keybank.pay.client.DepositClient.placeHold(DepositClient.java:88)',
        },
        payment_id: `PMT-${rng.int(100000, 999999)}`,
      },
      httpRequest: {
        requestMethod: 'POST',
        requestUrl: '/api/v1/payments',
        status: 504,
        latency: `${(ms / 1000 + rng.float(0, 0.05)).toFixed(3)}s`,
      },
    };
  }
  const dep = getApp('DEP');
  return {
    ...base(dep, ts, 'ERROR'),
    jsonPayload: {
      message: `HikariPool-1 - Connection is not available, request timed out after 30000ms (total=20, active=20, idle=0, waiting=${rng.int(10, 60)})`,
      logger: 'com.zaxxer.hikari.pool.HikariPool',
      error: {
        type: 'java.sql.SQLTransientConnectionException',
        message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms',
      },
    },
  };
}

async function main() {
  const count = option('count', 400);
  const now = Date.now();
  const entries: LogEntryInput[] = [];
  for (let i = 0; i < count; i++) {
    // Backfill: spread over the last 2 hours.
    entries.push(background(now - rng.int(0, 2 * 3600) * 1000 - rng.int(0, 999)));
  }
  // An error spike that started ~8 minutes ago.
  const spikeCount = Math.round(count * 0.2);
  for (let i = 0; i < spikeCount; i++) entries.push(spike(now - rng.int(0, 8 * 60_000)));
  entries.sort(() => rng.next() - 0.5); // arrive out of order

  for (let i = 0; i < entries.length; i += 500) {
    const res = await api.ingest({ entries: entries.slice(i, i + 500) });
    console.log(`ingested ${res.accepted} (last_seq=${res.last_seq})`);
  }

  if (flag('live')) {
    console.log('live mode: ~5 entries/s, Ctrl+C to stop');
    setInterval(async () => {
      const t = Date.now();
      const batch = Array.from({ length: 5 }, () => (rng.chance(0.3) ? spike(t) : background(t)));
      await api.ingest({ entries: batch }).catch((err) => console.error(err.message));
    }, 1000);
  }
}

await main();
