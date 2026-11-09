import { SHARED_GROUP_IDS } from '@sim/world';
import { javaLog, nodeLog } from '../logs';
import {
  CRD_CONTROLLER,
  CRD_HIKARI_BAD,
  CRD_HIKARI_ORIGINAL,
  CRD_PATHS,
  CRD_REPO,
} from '../repos/crd';
import { FRD_REPO } from '../repos/frd';
import { MBL_REPO } from '../repos/mbl';
import type { LogContext, ScenarioDefinition } from '../types';
import {
  dev,
  groupMember,
  javaFrame,
  javaStack,
  latency,
  lineOf,
  moogsoftAlert,
  springMvcFrames,
  springProxyFrames,
  stripHashComments,
  tpl,
  uuid,
} from '../util';

// ---------------------------------------------------------------------------
// Fix detection
// ---------------------------------------------------------------------------

/** Peak load needs ~25 connections per pod; anything below 20 still exhausts. */
const MIN_POOL = 20;

function crdIsFixed(files: Record<string, string | null>): boolean {
  const yml = stripHashComments(files[CRD_PATHS.applicationYml] ?? '');
  const size = yml.match(/maximum-pool-size\s*:\s*["']?(\d+)/)?.[1];
  // Missing means Hikari's default of 10, which is still too small.
  return size !== undefined && Number(size) >= MIN_POOL;
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const DBA = groupMember(SHARED_GROUP_IDS.dba, /Senior Database/);

const SVC = 'com.keybank.crd.service.CardControlService';

type Op = {
  name: 'listCards' | 'getCard' | 'updateControls';
  method: 'GET' | 'PUT';
  path: (ctx: LogContext) => string;
  needle: string;
};

const OPS: Op[] = [
  {
    name: 'listCards',
    method: 'GET',
    path: (ctx) => `/v1/customers/${ctx.customerId()}/cards`,
    needle: 'return cards.listCards(',
  },
  {
    name: 'getCard',
    method: 'GET',
    path: (ctx) => `/v1/cards/${uuid(ctx)}`,
    needle: 'return cards.getCard(',
  },
  {
    name: 'updateControls',
    method: 'PUT',
    path: (ctx) => `/v1/cards/${uuid(ctx)}/controls`,
    needle: 'return cards.updateControls(',
  },
];

function poolStats(ctx: LogContext) {
  const waiting = ctx.rng.int(18, 64);
  const timeout = 2000 + ctx.rng.int(0, 6);
  return {
    waiting,
    timeout,
    text: `HikariPool-1 - Connection is not available, request timed out after ${timeout}ms (total=5, active=5, idle=0, waiting=${waiting})`,
  };
}

function cannotCreateTxStack(op: Op, hikari: string): string {
  return javaStack(
    {
      type: 'org.springframework.transaction.CannotCreateTransactionException',
      message: 'Could not open JPA EntityManager for transaction',
      frames: [
        'org.springframework.orm.jpa.JpaTransactionManager.doBegin(JpaTransactionManager.java:466)',
        'org.springframework.transaction.support.AbstractPlatformTransactionManager.startTransaction(AbstractPlatformTransactionManager.java:531)',
        'org.springframework.transaction.support.AbstractPlatformTransactionManager.getTransaction(AbstractPlatformTransactionManager.java:405)',
        'org.springframework.transaction.interceptor.TransactionAspectSupport.createTransactionIfNecessary(TransactionAspectSupport.java:617)',
        'org.springframework.transaction.interceptor.TransactionAspectSupport.invokeWithinTransaction(TransactionAspectSupport.java:386)',
        'org.springframework.transaction.interceptor.TransactionInterceptor.invoke(TransactionInterceptor.java:119)',
        ...springProxyFrames(SVC, op.name).slice(4),
        javaFrame('com.keybank.crd.api.CardController', op.name, lineOf(CRD_CONTROLLER, op.needle)),
        ...springMvcFrames(op.method),
      ],
    },
    {
      type: 'org.hibernate.exception.JDBCConnectionException',
      message: `Unable to acquire JDBC Connection [${hikari}] [n/a]`,
      frames: [
        'org.hibernate.exception.internal.SQLStateConversionDelegate.convert(SQLStateConversionDelegate.java:100)',
        'org.hibernate.exception.internal.StandardSQLExceptionConverter.convert(StandardSQLExceptionConverter.java:58)',
        'org.hibernate.engine.jdbc.spi.SqlExceptionHelper.convert(SqlExceptionHelper.java:108)',
        'org.hibernate.engine.jdbc.spi.SqlExceptionHelper.convert(SqlExceptionHelper.java:94)',
        'org.hibernate.resource.jdbc.internal.LogicalConnectionManagedImpl.acquireConnectionIfNeeded(LogicalConnectionManagedImpl.java:116)',
        'org.hibernate.resource.jdbc.internal.LogicalConnectionManagedImpl.getPhysicalConnection(LogicalConnectionManagedImpl.java:143)',
        'org.hibernate.resource.jdbc.internal.LogicalConnectionManagedImpl.getConnectionForTransactionManagement(LogicalConnectionManagedImpl.java:273)',
        'org.hibernate.resource.jdbc.internal.LogicalConnectionManagedImpl.begin(LogicalConnectionManagedImpl.java:281)',
        'org.hibernate.resource.transaction.backend.jdbc.internal.JdbcResourceLocalTransactionCoordinatorImpl$TransactionDriverControlImpl.begin(JdbcResourceLocalTransactionCoordinatorImpl.java:232)',
        'org.hibernate.engine.transaction.internal.TransactionImpl.begin(TransactionImpl.java:83)',
        'org.springframework.orm.jpa.vendor.HibernateJpaDialect.beginTransaction(HibernateJpaDialect.java:176)',
        'org.springframework.orm.jpa.JpaTransactionManager.doBegin(JpaTransactionManager.java:420)',
      ],
      omitted: 52,
    },
    {
      type: 'java.sql.SQLTransientConnectionException',
      message: hikari,
      frames: [
        'com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:686)',
        'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:179)',
        'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:144)',
        'com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:127)',
        'org.hibernate.engine.jdbc.connections.internal.DatasourceConnectionProviderImpl.getConnection(DatasourceConnectionProviderImpl.java:122)',
        'org.hibernate.internal.NonContextualJdbcConnectionAccess.obtainConnection(NonContextualJdbcConnectionAccess.java:46)',
        'org.hibernate.resource.jdbc.internal.LogicalConnectionManagedImpl.acquireConnectionIfNeeded(LogicalConnectionManagedImpl.java:113)',
      ],
      omitted: 63,
    },
  );
}

export const crdPoolExhaustion: ScenarioDefinition = {
  id: 'crd-pool-exhaustion',
  title: 'Card management timing out',
  kind: 'single-app',
  summary:
    'Card lock/unlock and card controls start failing in the mobile app; the card management API is answering slowly with errors.',
  answerKey: {
    rootCause:
      'card-management-api (CRD) MR "Right-size Hikari pool per DBA review" cut spring.datasource.hikari.maximum-pool-size from 40 to 5 (sized on average active connections) and connection-timeout from 10s to 2s. At normal peak load requests queue for a connection and time out after 2s: HikariPool-1 ... (total=5, active=5, idle=0, waiting=NN), returned as 503. Fix: restore the pool size (40) and timeout.',
    culpritTla: 'CRD',
    affectedTlas: ['CRD', 'MBL'],
    whyItLooksGreen:
      'It does not: the fault is local to CRD and its own logs and alerts show it. The database itself is healthy (low connection count), which can mislead people into blaming Postgres or the network.',
  },
  badMr: {
    project: CRD_REPO,
    title: 'Right-size Hikari pool per DBA review',
    description: `## Context
DBA review **DBA-1187** flagged \`crd-pg-prod\` at 82% of \`max_connections\` (400). card-management-api reserves 8 pods x 40 = 320 connections, but \`pg_stat_activity\` shows a p95 of 3.2 active connections per pod over the last 30 days.

## Change
- \`maximum-pool-size\` 40 -> 5, \`minimum-idle\` 10 -> 2
- \`connection-timeout\` 10s -> 2s so callers fail fast instead of piling up Tomcat threads

Frees ~280 connections ahead of the DEP and FRD migrations next sprint. Reviewed with @${DBA} (DBA).`,
    author: dev('CRD', 3),
    approvers: [DBA, dev('CRD', 6)],
    mergedBy: dev('CRD', 3),
    sourceBranch: 'chore/DBA-1187-hikari-right-size',
    labels: ['database', 'config'],
    openedMinutesAgo: 2 * 24 * 60,
    edits: [{ path: CRD_PATHS.applicationYml, find: CRD_HIKARI_ORIGINAL, replace: CRD_HIKARI_BAD }],
  },
  fix: {
    title: 'Restore Hikari pool size and connection timeout',
    description: `## Why
The DBA-1187 MR ("Right-size Hikari pool per DBA review") sized the pool on average active connections (p95 3.2/pod over 30 days, sampled every 5 minutes). Real peaks are ~25 concurrent card-control requests per pod, so a pool of 5 with a 2s timeout exhausts immediately: \`HikariPool-1 - Connection is not available, request timed out after 2000ms (total=5, active=5, idle=0, waiting=40+)\` and 503s to MBL.

## Change
- Restore \`maximum-pool-size: 40\`, \`minimum-idle: 10\`, \`connection-timeout: 10000\`

The connection budget concern is real; follow-up with DBA on PgBouncer in transaction mode (DBA-1191).`,
    edits: [{ path: CRD_PATHS.applicationYml, find: CRD_HIKARI_BAD, replace: CRD_HIKARI_ORIGINAL }],
    files: [CRD_PATHS.applicationYml],
    isFixed: crdIsFixed,
  },
  faultOnsetSec: 30,
  impacts: [
    {
      tla: 'CRD',
      startAfterSec: 0,
      ratePerSec: 6,
      templates: [
        tpl(
          'ERROR',
          (ctx) => {
            const op = ctx.rng.pick(OPS);
            const path = op.path(ctx);
            const pool = poolStats(ctx);
            return javaLog(ctx, {
              logger: 'com.keybank.crd.api.ApiExceptionHandler',
              message: `${op.method} ${path} failed: database unavailable`,
              error: {
                type: 'org.springframework.transaction.CannotCreateTransactionException',
                message: 'Could not open JPA EntityManager for transaction',
                stack_trace: cannotCreateTxStack(op, pool.text),
              },
              http: {
                method: op.method,
                url: `https://cards.internal.keybank.example${path}`,
                status: 503,
                latencySec: pool.timeout / 1000 + latency(ctx, 0.002, 0.03),
              },
            });
          },
          3,
        ),
        tpl(
          'ERROR',
          (ctx) =>
            javaLog(ctx, {
              logger: 'org.hibernate.engine.jdbc.spi.SqlExceptionHelper',
              message: poolStats(ctx).text,
            }),
          2,
        ),
        tpl(
          'WARNING',
          (ctx) =>
            javaLog(ctx, {
              logger: 'org.hibernate.engine.jdbc.spi.SqlExceptionHelper',
              message: 'SQL Error: 0, SQLState: 08003',
            }),
          2,
        ),
      ],
    },
    {
      tla: 'MBL',
      startAfterSec: 15,
      ratePerSec: 0.8,
      templates: [
        tpl(
          'WARNING',
          (ctx) =>
            nodeLog(ctx, {
              message: 'card controls degraded, serving cached',
              fields: {
                upstream: 'card-management-api',
                upstreamStatus: ctx.rng.chance(0.8) ? 503 : 'timeout',
                cacheAgeSec: ctx.rng.int(20, 840),
                customerId: ctx.customerId(),
              },
            }),
          3,
        ),
        tpl('WARNING', (ctx) => {
          const cardId = uuid(ctx);
          return nodeLog(ctx, {
            message: 'card control update failed upstream',
            http: {
              method: 'PUT',
              url: `https://mobile-api.keybank.example/mobile/v2/cards/${cardId}/lock`,
              status: 503,
              latencySec: latency(ctx, 2.0, 2.2),
            },
            fields: { upstream: 'card-management-api', upstreamStatus: 503, cardId },
          });
        }),
      ],
    },
  ],
  alerts: [
    moogsoftAlert({
      atSec: 50,
      repeatEverySec: 60,
      tla: 'CRD',
      severity: 'critical',
      manager: 'AppDynamics',
      check: 'http_5xx_rate',
      description: 'HTTP 5xx error rate 46.2% on card-management-api (threshold 5%, 5m window)',
      custom: {
        appd_application: 'CRD-Prod',
        appd_tier: 'card-management-api',
        observed_pct: 46.2,
        threshold_pct: 5,
      },
    }),
    moogsoftAlert({
      atSec: 60,
      repeatEverySec: 60,
      tla: 'CRD',
      severity: 'major',
      manager: 'Prometheus',
      check: 'hikaricp_pending_threads',
      description:
        'HikariCP pending threads 38 on card-management-api pool HikariPool-1 (threshold 10)',
      custom: {
        metric: 'hikaricp_connections_pending',
        pool: 'HikariPool-1',
        observed: 38,
        threshold: 10,
      },
    }),
    moogsoftAlert({
      atSec: 80,
      repeatEverySec: 120,
      tla: 'CRD',
      severity: 'warning',
      manager: 'AppDynamics',
      check: 'response_time_p95',
      description: 'p95 response time 2.08s on card-management-api (baseline 84ms)',
      custom: { appd_application: 'CRD-Prod', observed_ms: 2080, baseline_ms: 84 },
    }),
  ],
  redHerrings: [
    {
      atSec: 15,
      kind: 'merge',
      project: FRD_REPO,
      title: 'Tune card-not-present velocity thresholds (FRM-622)',
      description:
        'Raises the CNP velocity threshold from 6 to 8 transactions per 10 minutes for PREMIER/PRIVATE segments. Rules only, model unchanged.',
      author: dev('FRD', 1),
      mergedBy: dev('FRD', 4),
      sourceBranch: 'rules/FRM-622-cnp-velocity',
      labels: ['fraud-rules'],
      edits: [
        {
          path: 'src/fraud_scoring_engine/rules/cnp_velocity.yaml',
          content: `# Card-not-present velocity rule (FRM-622).
rule: cnp_velocity
window_minutes: 10
thresholds:
  default: 6
  PREMIER: 8
  PRIVATE: 8
action: REVIEW
`,
        },
      ],
    },
    {
      atSec: 35,
      kind: 'commit',
      project: MBL_REPO,
      title: 'Add feature flag for card art refresh',
      author: dev('MBL', 1),
      edits: [
        {
          path: 'src/flags/cardArtRefresh.ts',
          content: `/** Serves the 2027 card art set to app versions that support it (MBL-1440). */
export const cardArtRefresh = {
  key: 'card-art-refresh-2027',
  enabled: false,
  minAppVersion: '7.42.0',
} as const;
`,
        },
      ],
    },
  ],
};
