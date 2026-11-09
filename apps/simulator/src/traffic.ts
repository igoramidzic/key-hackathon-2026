import type { LogEntryInput } from '@sim/contracts/logs';
import { type App, getWorld, Rng, type Stack, slugify } from '@sim/world';
import { type Estate, type LineSpec, stackStyle } from './estate';
import { accountNumber, customerId, internalIp, latencyMs, routingNumber, uuid } from './values';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  method: Method;
  /** Path with placeholders like `{customerId}`. */
  path: string;
  weight: number;
  latencyMs: number;
  /** Controller / module name, e.g. `Payment` → `PaymentController`, `payments`. */
  resource: string;
}

const r = (
  method: Method,
  path: string,
  weight: number,
  latency: number,
  resource: string,
): Route => ({
  method,
  path,
  weight,
  latencyMs: latency,
  resource,
});

/** Hand-written routes for the hero apps. */
export const HERO_ROUTES: Record<string, Route[]> = {
  ATH: [
    r('POST', '/oauth2/token', 50, 38, 'Token'),
    r('POST', '/oauth2/introspect', 30, 9, 'Introspection'),
    r('GET', '/.well-known/jwks.json', 14, 3, 'Jwks'),
    r('POST', '/oauth2/revoke', 6, 14, 'Token'),
  ],
  GLD: [
    r('POST', '/v1/postings', 45, 62, 'Posting'),
    r('GET', '/v1/postings/{uuid}', 15, 18, 'Posting'),
    r('GET', '/v1/gl-accounts/{glAccount}/balance', 30, 24, 'GlAccount'),
    r('POST', '/v1/postings/reversals', 4, 80, 'Reversal'),
  ],
  CIF: [
    r('GET', '/v1/customers/{customerId}', 45, 22, 'Customer'),
    r('GET', '/v1/customers/{customerId}/accounts', 25, 35, 'CustomerAccount'),
    r('GET', '/v1/customers/search', 8, 120, 'CustomerSearch'),
    r('PATCH', '/v1/customers/{customerId}/contact', 4, 48, 'CustomerContact'),
    r('GET', '/v1/customers/{customerId}/relationships', 10, 41, 'Relationship'),
  ],
  DEP: [
    r('GET', '/v1/accounts/{accountId}', 30, 26, 'Account'),
    r('GET', '/v1/accounts/{accountId}/balance', 35, 17, 'Balance'),
    r('GET', '/v1/accounts/{accountId}/transactions', 20, 64, 'Transaction'),
    r('POST', '/v1/accounts/{accountId}/holds', 8, 44, 'Hold'),
    r('DELETE', '/v1/accounts/{accountId}/holds/{uuid}', 3, 31, 'Hold'),
  ],
  NTF: [
    r('POST', '/v1/notifications', 60, 28, 'notifications'),
    r('POST', '/v1/notifications/batch', 10, 140, 'notifications'),
    r('GET', '/v1/notifications/{uuid}', 20, 9, 'notifications'),
    r('GET', '/v1/preferences/{customerId}', 10, 12, 'preferences'),
  ],
  FRD: [
    r('POST', '/v1/score', 60, 21, 'score'),
    r('POST', '/v1/score/card', 30, 17, 'score'),
    r('GET', '/v1/models/active', 4, 5, 'models'),
    r('POST', '/v1/feedback', 6, 11, 'feedback'),
  ],
  ABA: [
    r('GET', '/v1/routing/{routing}', 60, 6, 'routing'),
    r('POST', '/v1/routing/validate', 35, 8, 'routing'),
    r('GET', '/v1/institutions/{routing}', 5, 11, 'institutions'),
  ],
  ACH: [
    r('POST', '/v1/ach/entries', 45, 74, 'AchEntry'),
    r('POST', '/v1/ach/entries/validate', 25, 39, 'AchValidation'),
    r('GET', '/v1/ach/batches/{batchId}', 15, 28, 'AchBatch'),
    r('GET', '/v1/ach/entries/{uuid}', 15, 16, 'AchEntry'),
  ],
  WIR: [
    r('POST', '/v1/wires', 35, 130, 'Wire'),
    r('GET', '/v1/wires/{wireId}', 30, 21, 'Wire'),
    r('GET', '/v1/wires/{wireId}/status', 30, 14, 'WireStatus'),
    r('POST', '/v1/wires/{wireId}/approve', 5, 88, 'WireApproval'),
  ],
  PAY: [
    r('POST', '/v1/payments', 35, 160, 'Payment'),
    r('GET', '/v1/payments/{paymentId}', 30, 24, 'Payment'),
    r('GET', '/v1/payments', 15, 58, 'Payment'),
    r('POST', '/v1/transfers', 15, 140, 'Transfer'),
    r('POST', '/v1/payments/{paymentId}/cancel', 5, 70, 'Payment'),
  ],
  BPY: [
    r('GET', '/v1/payees', 30, 34, 'payees'),
    r('POST', '/v1/payees', 6, 92, 'payees'),
    r('POST', '/v1/bill-payments', 30, 180, 'billPayments'),
    r('GET', '/v1/bill-payments/scheduled', 34, 47, 'billPayments'),
  ],
  CRD: [
    r('GET', '/v1/cards/{cardId}', 35, 25, 'Card'),
    r('GET', '/v1/cards', 25, 42, 'Card'),
    r('POST', '/v1/cards/{cardId}/lock', 10, 66, 'CardControl'),
    r('PUT', '/v1/cards/{cardId}/limits', 6, 71, 'CardLimit'),
    r('POST', '/v1/cards/{cardId}/travel-notices', 4, 38, 'TravelNotice'),
    r('GET', '/v1/cards/{cardId}/controls', 20, 19, 'CardControl'),
  ],
  TLR: [
    r('POST', '/v1/teller/transactions', 40, 110, 'TellerTransaction'),
    r('GET', '/v1/customers/{customerId}/summary', 30, 95, 'CustomerSummary'),
    r('GET', '/v1/drawers/{drawerId}', 20, 15, 'Drawer'),
    r('POST', '/v1/drawers/{drawerId}/balance', 10, 60, 'DrawerBalance'),
  ],
  OLB: [
    r('GET', '/api/accounts', 30, 140, 'accounts'),
    r('GET', '/api/accounts/{accountId}/activity', 25, 160, 'accounts'),
    r('POST', '/api/transfers', 10, 260, 'transfers'),
    r('GET', '/api/profile', 15, 70, 'profile'),
    r('POST', '/api/billpay/payments', 8, 290, 'billpay'),
    r('GET', '/api/session', 12, 18, 'session'),
  ],
  MBL: [
    r('POST', '/mobile/v2/session', 15, 95, 'session'),
    r('GET', '/mobile/v2/accounts', 35, 130, 'accounts'),
    r('GET', '/mobile/v2/cards', 15, 85, 'cards'),
    r('POST', '/mobile/v2/transfers', 10, 240, 'transfers'),
    r('POST', '/mobile/v2/cards/{cardId}/lock', 5, 120, 'cards'),
    r('GET', '/mobile/v2/accounts/{accountId}/transactions', 20, 150, 'accounts'),
  ],
};

const SUFFIXES = [
  'Batch Processor',
  'Feed Processor',
  'Rules Service',
  'Document Service',
  'Data Mart',
  'Portal',
  'Gateway',
  'Engine',
  'Service',
  'Hub',
  'Reporting',
  'Analytics',
  'Workbench',
  'Scheduler',
  'Adapter',
  'Orchestrator',
  'Ledger',
  'API',
  'Console',
  'Reconciliation',
  'Notifications',
  'Archive',
  'Exchange',
  'Monitor',
  'Calculator',
];

export function splitAppName(name: string): { domain: string; suffix: string } {
  const suffix = SUFFIXES.find((s) => name.endsWith(` ${s}`)) ?? 'Service';
  return { domain: name.slice(0, name.length - suffix.length).trim() || name, suffix };
}

const pascal = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('');

/** Routes for generated apps, derived from the app name (`Mortgage Servicing Engine`). */
export function generatedRoutes(app: App): Route[] {
  const { domain, suffix } = splitAppName(app.name);
  const d = slugify(domain);
  const res = pascal(domain);
  switch (suffix) {
    case 'Portal':
    case 'Console':
    case 'Workbench':
      return [
        r('GET', '/api/cases', 30, 85, `${res}Case`),
        r('GET', '/api/cases/{id}', 35, 42, `${res}Case`),
        r('POST', '/api/cases/{id}/notes', 10, 66, `${res}CaseNote`),
        r('GET', '/api/dashboard', 25, 140, `${res}Dashboard`),
      ];
    case 'Gateway':
    case 'Adapter':
    case 'Exchange':
      return [
        r('POST', `/v1/${d}/messages`, 45, 95, `${res}Message`),
        r('GET', `/v1/${d}/messages/{uuid}/status`, 35, 18, `${res}Message`),
        r('POST', `/v1/${d}/callbacks`, 20, 33, `${res}Callback`),
      ];
    case 'Engine':
    case 'Rules Service':
    case 'Calculator':
      return [
        r('POST', `/v1/${d}/evaluate`, 50, 48, `${res}Evaluation`),
        r('POST', `/v1/${d}/calculate`, 30, 36, `${res}Calculation`),
        r('GET', `/v1/${d}/rules/{id}`, 20, 12, `${res}Rule`),
      ];
    case 'Ledger':
      return [
        r('POST', `/v1/${d}/postings`, 45, 58, `${res}Posting`),
        r('GET', `/v1/${d}/balances/{accountId}`, 40, 21, `${res}Balance`),
        r('GET', `/v1/${d}/postings/{uuid}`, 15, 17, `${res}Posting`),
      ];
    case 'Document Service':
      return [
        r('POST', '/v1/documents', 35, 210, `${res}Document`),
        r('GET', '/v1/documents/{uuid}', 50, 45, `${res}Document`),
        r('GET', '/v1/documents/{uuid}/content', 15, 120, `${res}DocumentContent`),
      ];
    case 'Orchestrator':
      return [
        r('POST', `/v1/${d}/workflows`, 35, 120, `${res}Workflow`),
        r('GET', `/v1/${d}/workflows/{uuid}`, 45, 22, `${res}Workflow`),
        r('POST', `/v1/${d}/workflows/{uuid}/signal`, 20, 54, `${res}WorkflowSignal`),
      ];
    case 'Notifications':
      return [
        r('POST', `/v1/${d}/notifications`, 70, 34, `${res}Notification`),
        r('GET', `/v1/${d}/notifications/{uuid}`, 30, 11, `${res}Notification`),
      ];
    case 'Monitor':
      return [
        r('POST', `/v1/${d}/events`, 60, 15, `${res}Event`),
        r('GET', `/v1/${d}/checks`, 40, 28, `${res}Check`),
      ];
    case 'Scheduler':
    case 'Batch Processor':
    case 'Feed Processor':
    case 'Reconciliation':
    case 'Data Mart':
    case 'Archive':
    case 'Reporting':
    case 'Analytics':
      return [
        r('GET', '/v1/jobs/{id}', 40, 16, `${res}Job`),
        r('POST', `/v1/jobs/${d}-daily/run`, 5, 64, `${res}Job`),
        r('GET', `/v1/${d}/reports/{id}`, 35, 180, `${res}Report`),
        r('GET', `/v1/${d}/summary`, 20, 95, `${res}Summary`),
      ];
    default:
      return [
        r('GET', `/v1/${d}/{id}`, 45, 28, res),
        r('POST', `/v1/${d}`, 20, 74, res),
        r('GET', `/v1/${d}`, 25, 52, res),
        r('PUT', `/v1/${d}/{id}`, 10, 61, res),
      ];
  }
}

function fillPath(path: string, rng: Rng): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    switch (key) {
      case 'customerId':
        return customerId(rng);
      case 'accountId':
        return accountNumber(rng);
      case 'paymentId':
        return `PMT-${rng.alnum(10).toUpperCase()}`;
      case 'cardId':
        return `crd_${rng.alnum(14)}`;
      case 'wireId':
        return `WR${rng.int(10_000_000, 99_999_999)}`;
      case 'routing':
        return routingNumber(rng);
      case 'glAccount':
        return `${rng.int(1000, 9999)}-${rng.int(100, 999)}`;
      case 'drawerId':
        return `BR${rng.int(100, 480)}-D${rng.int(1, 12)}`;
      case 'batchId':
        return `ACHB-${rng.int(100_000, 999_999)}`;
      case 'uuid':
        return uuid(rng);
      default:
        return String(rng.int(100_000, 9_999_999));
    }
  });
}

// ---------------------------------------------------------------------------
// Periodic jobs
// ---------------------------------------------------------------------------

interface JobSpec {
  periodSec: number;
  render(rng: Rng): LineSpec;
}

const HERO_JOBS: Record<string, JobSpec[]> = {
  ATH: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: `token cache stats hit_ratio=${rng.float(0.95, 0.99).toFixed(3)} size=${rng.int(40_000, 52_000)}`,
        logger: 'cache',
      }),
    },
    {
      periodSec: 300,
      render: () => ({
        severity: 'INFO',
        message: 'JWKS signing key check: active kid=ath-2026-11 rotates in 21d',
        logger: 'keys',
      }),
    },
  ],
  GLD: [
    {
      periodSec: 30,
      render: (rng) => ({
        severity: 'INFO',
        message: `Posting batch flushed: ${rng.int(180, 620)} entries to ledger partition ${rng.int(0, 15)}`,
        logger: 'c.k.gld.posting.PostingBatchWriter',
        thread: 'posting-writer-1',
      }),
    },
  ],
  CIF: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: `Profile cache stats size=${rng.int(180_000, 210_000)} hitRatio=${rng.float(0.88, 0.95).toFixed(3)} evictions=${rng.int(0, 400)}`,
        logger: 'c.k.cif.cache.ProfileCacheMetrics',
        thread: 'scheduling-1',
      }),
    },
  ],
  DEP: [
    {
      periodSec: 120,
      render: (rng) => ({
        severity: 'INFO',
        message: `Hold expiry sweep released ${rng.int(5, 60)} holds`,
        logger: 'c.k.dep.holds.HoldExpiryJob',
        thread: 'scheduling-1',
      }),
    },
  ],
  NTF: [
    {
      periodSec: 30,
      render: (rng) => ({
        severity: 'INFO',
        message: 'dispatch batch complete',
        logger: 'dispatcher',
        fields: { email: rng.int(60, 180), sms: rng.int(10, 60), push: rng.int(200, 600) },
      }),
    },
  ],
  FRD: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: `Model fraud-gbm-v7.3 serving; p95 score latency ${rng.int(14, 24)}ms, decisions=${rng.int(900, 1500)}/min`,
        logger: 'fraud_scoring_engine.model.registry',
        thread: 'MainThread',
      }),
    },
  ],
  ABA: [
    {
      periodSec: 300,
      render: () => ({
        severity: 'INFO',
        message: 'Fed routing directory snapshot current (as of 2026-11-06, 28,113 entries)',
        logger: 'directory',
      }),
    },
  ],
  ACH: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: `Batch window open: next FedACH transmission cutoff 14:45 ET, pending entries=${rng.int(800, 2400).toLocaleString('en-US')}`,
        logger: 'c.k.ach.batch.TransmissionScheduler',
        thread: 'scheduling-1',
      }),
    },
  ],
  WIR: [
    {
      periodSec: 30,
      render: (rng) => ({
        severity: 'INFO',
        message: `Fedwire session heartbeat OK (IMAD seq ${rng.int(100_000, 999_999)})`,
        logger: 'c.k.wir.fedwire.FedwireSession',
        thread: 'fedwire-heartbeat',
      }),
    },
  ],
  PAY: [
    {
      periodSec: 120,
      render: (rng) => ({
        severity: 'INFO',
        message: `Payment state reconciler: scanned ${rng.int(2000, 6000)} in-flight payments, 0 stuck`,
        logger: 'c.k.pay.recon.PaymentStateReconciler',
        thread: 'scheduling-1',
      }),
    },
  ],
  BPY: [
    {
      periodSec: 300,
      render: (rng) => ({
        severity: 'INFO',
        message: 'scheduled payments queued for today',
        logger: 'scheduler',
        fields: { queued: rng.int(2800, 4200) },
      }),
    },
  ],
  CRD: [
    {
      periodSec: 120,
      render: (rng) => ({
        severity: 'INFO',
        message: `Card status sync to processor complete (updated=${rng.int(20, 300)})`,
        logger: 'c.k.crd.sync.ProcessorStatusSync',
        thread: 'scheduling-1',
      }),
    },
  ],
  TLR: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: `Workstation heartbeat: ${rng.int(180, 240)} active teller sessions across ${rng.int(60, 75)} branches`,
        logger: 'c.k.tlr.session.WorkstationHeartbeat',
        thread: 'scheduling-1',
      }),
    },
  ],
  OLB: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: 'session store stats',
        logger: 'session',
        fields: { active_sessions: rng.int(9000, 14_000) },
      }),
    },
  ],
  MBL: [
    {
      periodSec: 60,
      render: (rng) => ({
        severity: 'INFO',
        message: 'active mobile sessions',
        logger: 'session',
        fields: { ios: rng.int(6000, 9000), android: rng.int(4000, 7000) },
      }),
    },
  ],
};

function stackJobs(app: App, service: string, stack: Stack): JobSpec[] {
  const pkg = stackStyle.javaPackage(app.tla);
  const topic = `${app.tla.toLowerCase()}.events.v1`;
  const lagJob: JobSpec = {
    periodSec: 45 + (app.tla.charCodeAt(1) % 30),
    render: (rng) =>
      stack === 'java-spring'
        ? {
            severity: 'INFO',
            message: `Consumer group ${service} lag: topic=${topic} partitions=6 total_lag=${rng.int(0, 120)}`,
            logger: 'o.a.k.c.c.internals.ConsumerCoordinator',
            thread: `org.springframework.kafka.KafkaListenerEndpointContainer#0-0-C-1`,
          }
        : stack === 'python'
          ? {
              severity: 'INFO',
              message: `consumer lag topic=${topic} lag=${rng.int(0, 120)}`,
              logger: `${service.replace(/-/g, '_')}.consumer`,
              thread: 'MainThread',
            }
          : {
              severity: 'INFO',
              message: 'consumer lag',
              logger: 'kafka',
              fields: { topic, groupId: service, lag: rng.int(0, 120) },
            },
  };
  const runtimeJob: JobSpec =
    stack === 'java-spring'
      ? {
          periodSec: 60,
          render: (rng) => {
            const active = rng.int(1, 6);
            return {
              severity: 'INFO',
              message: `HikariPool-1 - Pool stats (total=20, active=${active}, idle=${20 - active}, waiting=0)`,
              logger: 'com.zaxxer.hikari.pool.HikariPool',
              thread: 'HikariPool-1 housekeeper',
            };
          },
        }
      : stack === 'python'
        ? {
            periodSec: 90,
            render: (rng) => ({
              severity: 'INFO',
              message: `worker heartbeat rss=${rng.int(180, 420)}MB open_connections=${rng.int(4, 20)}`,
              logger: `${service.replace(/-/g, '_')}.health`,
              thread: 'MainThread',
            }),
          }
        : {
            periodSec: 90,
            render: (rng) => ({
              severity: 'INFO',
              message: 'runtime stats',
              logger: 'metrics',
              fields: {
                heapUsedMB: rng.int(110, 260),
                rssMB: rng.int(240, 420),
                eventLoopLagP99Ms: rng.int(4, 30),
              },
            }),
          };
  const { domain, suffix } = splitAppName(app.name);
  const d = slugify(domain);
  const jobs: JobSpec[] = [runtimeJob];
  const logger = (name: string) =>
    stack === 'java-spring'
      ? `${pkg}.jobs.${name}`
      : stack === 'python'
        ? `${service.replace(/-/g, '_')}.jobs`
        : 'jobs';
  switch (suffix) {
    case 'Scheduler':
      jobs.push({
        periodSec: 120,
        render: (rng) => ({
          severity: 'INFO',
          message: `Job ${d}-sweep completed in ${rng.int(200, 4000)}ms (processed=${rng.int(10, 900)})`,
          logger: logger('SweepJob'),
          thread: stack === 'java-spring' ? 'scheduling-1' : undefined,
        }),
      });
      break;
    case 'Batch Processor':
    case 'Feed Processor':
      jobs.push({
        periodSec: 180,
        render: (rng) => ({
          severity: 'INFO',
          message: `Processed file ${d.replace(/-/g, '_')}_20261109_${String(rng.int(1, 40)).padStart(3, '0')}.csv: ${rng.int(500, 20_000)} records, ${rng.int(0, 4)} rejected`,
          logger: logger('FileIngestJob'),
          thread: stack === 'java-spring' ? 'batch-worker-1' : undefined,
        }),
      });
      break;
    case 'Reconciliation':
      jobs.push({
        periodSec: 300,
        render: (rng) => ({
          severity: 'INFO',
          message: `Reconciliation run ${uuid(rng).slice(0, 8)}: matched=${rng.int(4000, 9000)} breaks=${rng.int(0, 3)}`,
          logger: logger('ReconciliationJob'),
          thread: stack === 'java-spring' ? 'scheduling-1' : undefined,
        }),
      });
      break;
    case 'Data Mart':
    case 'Reporting':
    case 'Analytics':
      jobs.push({
        periodSec: 240,
        render: (rng) => ({
          severity: 'INFO',
          message: `Refreshed materialized view mv_${d.replace(/-/g, '_')}_daily in ${rng.int(800, 9000)}ms`,
          logger: logger('ViewRefreshJob'),
          thread: stack === 'java-spring' ? 'scheduling-1' : undefined,
        }),
      });
      break;
    case 'Archive':
      jobs.push({
        periodSec: 300,
        render: (rng) => ({
          severity: 'INFO',
          message: `Archived ${rng.int(100, 5000)} records older than 7y to gs://kb-archive-${app.tla.toLowerCase()}00/${d}/`,
          logger: logger('ArchiveJob'),
          thread: stack === 'java-spring' ? 'scheduling-1' : undefined,
        }),
      });
      break;
    case 'Notifications':
    case 'Hub':
    case 'Exchange':
    case 'Gateway':
      jobs.push(lagJob);
      break;
    default:
      jobs.push({
        periodSec: 120,
        render: (rng) => ({
          severity: 'INFO',
          message:
            stack === 'node-ts'
              ? 'reference data cache refreshed'
              : `Reference data cache refreshed (${rng.int(200, 4000)} entries)`,
          logger: stack === 'node-ts' ? 'cache' : logger('ReferenceDataRefresher'),
          thread: stack === 'java-spring' ? 'scheduling-1' : undefined,
          fields:
            stack === 'node-ts'
              ? { entries: rng.int(200, 4000), durationMs: rng.int(20, 400) }
              : undefined,
        }),
      });
  }
  if (app.hero) {
    jobs.push(lagJob, ...(HERO_JOBS[app.tla] ?? []));
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface TrafficProfile {
  app: App;
  service: string;
  stack: Stack;
  /** Lines per second at rate multiplier 1. */
  rate: number;
  routes: Route[];
  jobs: JobSpec[];
  /** Upstream services this app calls (for retry/timeout lines). */
  upstreams: { tla: string; service: string }[];
  /** Callers (user agents) for request lines. */
  callers: string[];
}

const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
];
const MOBILE_UAS = [
  'KeyBankMobile/8.14.2 (iOS 18.1; iPhone15,3)',
  'KeyBankMobile/8.14.2 (iOS 17.6.1; iPhone14,5)',
  'KeyBankMobile/8.14.1 (Android 15; Pixel 8)',
  'KeyBankMobile/8.13.0 (Android 14; SM-S918U)',
];

function baseRate(app: App): number {
  if (app.hero) return app.tier === 1 ? 0.7 : 0.45;
  return app.tier === 1 ? 0.36 : app.tier === 2 ? 0.26 : 0.16;
}

export function buildProfiles(): TrafficProfile[] {
  const world = getWorld();
  const logging = world.apps.filter((a) => a.emitsLogs);
  return logging.map((app) => {
    const stack = app.stack;
    const service = app.runtime.service;
    const callers = app.downstream
      .map((t) => world.appsByTla.get(t))
      .filter((a): a is App => Boolean(a?.emitsLogs))
      .map((a) => {
        const v = new Rng(`ua:${a.tla}`);
        const lib =
          a.stack === 'java-spring'
            ? 'Java-http-client/21.0.4'
            : a.stack === 'python'
              ? 'python-httpx/0.27.2'
              : 'undici/6.21.0';
        return `${a.runtime.service}/${v.int(1, 5)}.${v.int(0, 30)} ${lib}`;
      });
    const uas =
      app.tla === 'OLB'
        ? BROWSER_UAS
        : app.tla === 'MBL'
          ? MOBILE_UAS
          : callers.length > 0
            ? callers
            : ['kb-api-gateway/2.8 (envoy)'];
    return {
      app,
      service,
      stack,
      rate: baseRate(app),
      routes: HERO_ROUTES[app.tla] ?? generatedRoutes(app),
      jobs: stackJobs(app, service, stack),
      upstreams: app.upstream
        .map((t) => world.appsByTla.get(t))
        .filter((a): a is App => Boolean(a))
        .map((a) => ({ tla: a.tla, service: a.runtime.service })),
      callers: uas,
    };
  });
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

/** POSTs that create a resource (201); action endpoints (score, validate, token, ...) return 200. */
const ACTIONS =
  /\/(score|card|validate|evaluate|calculate|introspect|token|revoke|lock|run|signal|approve|cancel|balance|session|feedback|reversals|callbacks|events|batch)$/;

function statusFor(route: Route, rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.012) return 404;
  if (roll < 0.02) return 400;
  if (roll < 0.024) return 401;
  if (route.method === 'POST') return ACTIONS.test(route.path) ? 200 : 201;
  if (route.method === 'DELETE') return 204;
  return 200;
}

function requestLine(p: TrafficProfile, rng: Rng, slow = false): LineSpec {
  const route = rng.weighted(p.routes.map((rt) => [rt, rt.weight] as const));
  const path = fillPath(route.path, rng);
  const status = slow ? 200 : statusFor(route, rng);
  // Slow requests always exceed the 2000 ms timing-filter threshold they are logged against.
  const ms = slow ? Math.max(2050, latencyMs(rng, 2600, 0.3)) : latencyMs(rng, route.latencyMs);
  const ua = rng.pick(p.callers);
  const ip = internalIp(rng);
  const http = {
    requestMethod: route.method,
    requestUrl: path,
    status,
    latencySec: ms / 1000,
    userAgent: ua,
    remoteIp: ip,
  };
  const reqId = uuid(rng);
  if (p.stack === 'java-spring') {
    const logger = `${stackStyle.javaPackage(p.app.tla)}.web.${route.resource}Controller`;
    return slow
      ? {
          severity: 'WARNING',
          message: `Slow request: ${route.method} ${path} took ${ms} ms (threshold 2000 ms)`,
          logger: `${stackStyle.javaPackage(p.app.tla)}.web.RequestTimingFilter`,
          httpRequest: http,
          fields: { request_id: reqId },
        }
      : {
          severity: 'INFO',
          message: `${route.method} ${path} ${status} ${ms}ms`,
          logger,
          httpRequest: http,
          fields: { request_id: reqId },
        };
  }
  if (p.stack === 'python') {
    return slow
      ? {
          severity: 'WARNING',
          message: `Slow request ${route.method} ${path} took ${(ms / 1000).toFixed(2)}s`,
          logger: `${p.service.replace(/-/g, '_')}.middleware.timing`,
          httpRequest: http,
          fields: { request_id: reqId },
        }
      : {
          severity: 'INFO',
          message: `${ip}:${rng.int(32768, 60999)} - "${route.method} ${path} HTTP/1.1" ${status}`,
          logger: 'uvicorn.access',
          thread: 'MainThread',
          httpRequest: http,
        };
  }
  return {
    severity: slow ? 'WARNING' : 'INFO',
    message: slow ? 'slow request' : 'request completed',
    logger: 'http',
    httpRequest: http,
    fields: {
      reqId,
      req: { method: route.method, url: path },
      res: { statusCode: status },
      responseTime: ms,
    },
  };
}

function miscInfoLine(p: TrafficProfile, rng: Rng): LineSpec {
  const pkg = stackStyle.javaPackage(p.app.tla);
  const up = p.upstreams.length > 0 ? rng.pick(p.upstreams) : null;
  const topic = `${p.app.tla.toLowerCase()}.events.v1`;
  if (up && rng.chance(0.5)) {
    const ms = latencyMs(rng, 30);
    if (p.stack === 'java-spring') {
      return {
        severity: 'INFO',
        message: `Call to ${up.service} completed in ${ms} ms`,
        logger: `${pkg}.client.${pascal(up.service)}Client`,
        trace: true,
      };
    }
    if (p.stack === 'python') {
      return {
        severity: 'INFO',
        message: `HTTP Request: GET http://${up.service}.${up.tla.toLowerCase()}00.svc.cluster.local/ "HTTP/1.1 200 OK"`,
        logger: 'httpx',
        trace: true,
      };
    }
    return {
      severity: 'INFO',
      message: 'upstream call completed',
      logger: `clients/${up.service}`,
      fields: { upstream: up.service, durationMs: ms, statusCode: 200 },
      trace: true,
    };
  }
  const offset = rng.int(100_000, 9_999_999);
  if (p.stack === 'java-spring') {
    return {
      severity: 'INFO',
      message: `Published event to ${topic} partition=${rng.int(0, 5)} offset=${offset}`,
      logger: `${pkg}.events.EventPublisher`,
      thread: `kafka-producer-network-thread | ${p.service}`,
    };
  }
  if (p.stack === 'python') {
    return {
      severity: 'INFO',
      message: `Published event to ${topic} (partition ${rng.int(0, 5)}, offset ${offset})`,
      logger: `${p.service.replace(/-/g, '_')}.events`,
    };
  }
  return {
    severity: 'INFO',
    message: 'event published',
    logger: 'events',
    fields: { topic, partition: rng.int(0, 5), offset },
  };
}

function warnLine(p: TrafficProfile, rng: Rng): LineSpec {
  const roll = rng.next();
  if (roll < 0.45) return requestLine(p, rng, true);
  const pkg = stackStyle.javaPackage(p.app.tla);
  if (roll < 0.8 && p.upstreams.length > 0) {
    const up = rng.pick(p.upstreams);
    if (p.stack === 'java-spring') {
      return {
        severity: 'WARNING',
        message: `Retrying call to ${up.service} (attempt 2/3) after java.net.SocketTimeoutException: Read timed out`,
        logger: `${pkg}.client.${pascal(up.service)}Client`,
        trace: true,
      };
    }
    if (p.stack === 'python') {
      return {
        severity: 'WARNING',
        message: `Retrying ${up.service} request (attempt 2/3) after httpx.ReadTimeout`,
        logger: `${p.service.replace(/-/g, '_')}.clients`,
        trace: true,
      };
    }
    return {
      severity: 'WARNING',
      message: 'upstream call failed, retrying',
      logger: `clients/${up.service}`,
      fields: { upstream: up.service, attempt: 2, maxAttempts: 3, err: 'ETIMEDOUT' },
      trace: true,
    };
  }
  const ua = rng.pick(p.callers);
  const route = rng.pick(p.routes);
  const message = `Client ${ua.split(' ')[0]} called deprecated API version v1 on ${route.method} ${route.path} (sunset 2027-03-31)`;
  if (p.stack === 'node-ts') {
    return {
      severity: 'WARNING',
      message: 'deprecated api version requested',
      logger: 'http',
      fields: { client: ua.split(' ')[0], apiVersion: 'v1', sunset: '2027-03-31' },
    };
  }
  return {
    severity: 'WARNING',
    message,
    logger:
      p.stack === 'java-spring'
        ? `${pkg}.web.ApiVersionInterceptor`
        : `${p.service.replace(/-/g, '_')}.middleware.versioning`,
  };
}

function errorLine(p: TrafficProfile, rng: Rng): LineSpec {
  const route = rng.pick(p.routes);
  const path = fillPath(route.path, rng);
  const pkg = stackStyle.javaPackage(p.app.tla);
  const up = p.upstreams.length > 0 ? rng.pick(p.upstreams) : null;
  const disconnect = !up || rng.chance(0.6);
  if (p.stack === 'java-spring') {
    if (disconnect) {
      return {
        severity: 'ERROR',
        message: `Failed to write response for ${route.method} ${path}: client disconnected`,
        logger: 'o.a.c.c.C.[.[.[/].[dispatcherServlet]',
        error: {
          type: 'org.apache.catalina.connector.ClientAbortException',
          message: 'java.io.IOException: Broken pipe',
          stack_trace: [
            'org.apache.catalina.connector.ClientAbortException: java.io.IOException: Broken pipe',
            '\tat org.apache.catalina.connector.OutputBuffer.realWriteBytes(OutputBuffer.java:342)',
            '\tat org.apache.catalina.connector.OutputBuffer.flushByteBuffer(OutputBuffer.java:776)',
            '\tat org.springframework.http.converter.json.AbstractJackson2HttpMessageConverter.writeInternal(AbstractJackson2HttpMessageConverter.java:485)',
            'Caused by: java.io.IOException: Broken pipe',
            '\tat java.base/sun.nio.ch.SocketDispatcher.write0(Native Method)',
          ].join('\n'),
        },
        trace: true,
      };
    }
    return {
      severity: 'ERROR',
      message: `Request to ${up!.service} timed out after 5000 ms; ${route.method} ${path} returned 504`,
      logger: `${pkg}.client.${pascal(up!.service)}Client`,
      error: {
        type: 'org.springframework.web.client.ResourceAccessException',
        message: `I/O error on GET request for "http://${up!.service}.${up!.tla.toLowerCase()}00.svc.cluster.local:8080": Read timed out`,
        stack_trace: [
          `org.springframework.web.client.ResourceAccessException: I/O error on GET request for "http://${up!.service}.${up!.tla.toLowerCase()}00.svc.cluster.local:8080": Read timed out`,
          '\tat org.springframework.web.client.RestTemplate.createResourceAccessException(RestTemplate.java:915)',
          '\tat org.springframework.web.client.RestTemplate.doExecute(RestTemplate.java:895)',
          'Caused by: java.net.SocketTimeoutException: Read timed out',
        ].join('\n'),
      },
      trace: true,
    };
  }
  if (p.stack === 'python') {
    return disconnect
      ? {
          severity: 'ERROR',
          message: `Exception in ASGI application: client disconnected during ${route.method} ${path}`,
          logger: 'uvicorn.error',
          error: { type: 'starlette.requests.ClientDisconnect', message: 'Client disconnected' },
          trace: true,
        }
      : {
          severity: 'ERROR',
          message: `Upstream ${up!.service} timed out after 5.0s`,
          logger: `${p.service.replace(/-/g, '_')}.clients`,
          error: { type: 'httpx.ReadTimeout', message: 'timed out' },
          trace: true,
        };
  }
  return disconnect
    ? {
        severity: 'ERROR',
        message: 'request aborted',
        logger: 'http',
        error: {
          type: 'Error',
          message: 'aborted',
          stack_trace:
            'Error: aborted\n    at connResetException (node:internal/errors:787:14)\n    at abortIncoming (node:_http_server:793:17)',
        },
        fields: { code: 'ECONNRESET', req: { method: route.method, url: path } },
        trace: true,
      }
    : {
        severity: 'ERROR',
        message: 'upstream request failed',
        logger: `clients/${up!.service}`,
        error: {
          type: 'FetchError',
          message: `request to http://${up!.service}.${up!.tla.toLowerCase()}00.svc.cluster.local:8080 failed, reason: socket hang up`,
        },
        fields: { code: 'ECONNRESET', upstream: up!.service },
        trace: true,
      };
}

/** One baseline line for a profile. Mix: ~89% requests, ~7% misc info, ~3.5% warn, ~0.3% error. */
export function baselineLine(p: TrafficProfile, rng: Rng): LineSpec {
  const roll = rng.next();
  if (roll < 0.003) return errorLine(p, rng);
  if (roll < 0.038) return warnLine(p, rng);
  if (roll < 0.11) return miscInfoLine(p, rng);
  return requestLine(p, rng);
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface ProfileState {
  profile: TrafficProfile;
  rng: Rng;
  carry: number;
  jobNextAt: number[];
  /** Slow sinusoidal load variation. */
  phase: number;
}

/** Generates baseline traffic for every log-emitting app over arbitrary time windows. */
export class TrafficGenerator {
  private states: ProfileState[] = [];

  constructor(
    private readonly estate: Estate,
    readonly profiles: TrafficProfile[] = buildProfiles(),
  ) {}

  /** Resets RNG streams and job schedules so that generation starts at `startMs`. */
  init(startMs: number, seed = 'traffic'): void {
    this.states = this.profiles.map((profile) => {
      const rng = new Rng(`${seed}:${profile.app.tla}`);
      return {
        profile,
        rng,
        carry: rng.next(),
        jobNextAt: profile.jobs.map((j) => startMs + rng.float(0, j.periodSec) * 1000),
        phase: rng.float(0, Math.PI * 2),
      };
    });
  }

  /** Expected lines/sec at multiplier 1 (requests only, excluding periodic jobs). */
  get baselineRate(): number {
    return this.profiles.reduce((sum, p) => sum + p.rate, 0);
  }

  /** Lines for the window (fromMs, toMs]. */
  generate(fromMs: number, toMs: number, multiplier = 1): LogEntryInput[] {
    const out: LogEntryInput[] = [];
    const dt = (toMs - fromMs) / 1000;
    if (dt <= 0) return out;
    for (const st of this.states) {
      const { profile, rng } = st;
      const rt = this.estate.get(profile.app, profile.service);
      const wave = 1 + 0.15 * Math.sin(st.phase + toMs / 240_000);
      st.carry += profile.rate * multiplier * wave * dt;
      const n = Math.floor(st.carry);
      st.carry -= n;
      for (let i = 0; i < n; i++) {
        const ts = new Date(fromMs + rng.next() * (toMs - fromMs));
        out.push(this.estate.entry(rt, baselineLine(profile, rng), ts, rng));
      }
      profile.jobs.forEach((job, i) => {
        while (st.jobNextAt[i]! <= toMs) {
          const at = st.jobNextAt[i]!;
          st.jobNextAt[i] = at + job.periodSec * 1000 * rng.float(0.97, 1.03);
          if (at > fromMs && multiplier > 0) {
            out.push(this.estate.entry(rt, job.render(rng), new Date(at), rng));
          }
        }
      });
    }
    return out;
  }
}
