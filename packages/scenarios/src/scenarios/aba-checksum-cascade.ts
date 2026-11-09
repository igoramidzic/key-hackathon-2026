import { internalUrl, javaLog, javaPackage, nodeLog, perStack, pyLog, pyPackage } from '../logs';
import {
  ABA_BAD_SUM_LINE,
  ABA_CHECKSUM_OPTIMIZED_BLOCK,
  ABA_CHECKSUM_ORIGINAL_BLOCK,
  ABA_CHECKSUM_TEST_BAD,
  ABA_FIX_TEST_FIND,
  ABA_FIX_TEST_REPLACE,
  ABA_PATHS,
  ABA_REPO,
} from '../repos/aba';
import { ACH_BATCH_ASSEMBLY, ACH_ENTRY_VALIDATOR, ACH_REPO } from '../repos/ach';
import { WIR_REPO } from '../repos/wir';
import type { LogContext, ScenarioDefinition } from '../types';
import {
  dev,
  javaFrame,
  javaStack,
  latency,
  lineOf,
  moogsoftAlert,
  paymentId,
  springKafkaBatchFrames,
  stripCComments,
  tpl,
  yyyymmdd,
} from '../util';

// ---------------------------------------------------------------------------
// Fix detection
// ---------------------------------------------------------------------------

/** Fixed when the checksum weights are 3-7-1 again (array or unrolled expression). */
function abaIsFixed(files: Record<string, string | null>): boolean {
  const code = stripCComments(files[ABA_PATHS.checksum] ?? '').replace(/\s+/g, '');
  if (!code) return false;
  const swapped = code.includes('3*a+7*c+b') || /\[3,1,7/.test(code);
  const correct =
    /\[3,7,1(?:,3,7,1){0,2}\]/.test(code) ||
    /3\*\w+(?:\[[^\]]+\])?\+7\*\w+(?:\[[^\]]+\])?\+(?:1\*)?\w+/.test(code) ||
    /\w+\*3\+\w+\*7\+\w+/.test(code);
  return !swapped && correct;
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const CALLERS: (readonly [string, number])[] = [
  ['ach-origination', 6],
  ['wire-transfer-service', 2],
  ['billpay-service', 2],
  ['payments-api', 1],
  ['merchant-services-ledger', 1],
];

const ODFI = '04100103';

/** What the broken checksum computes (3a + 7c + b per group). */
function passesSwappedChecksum(rtn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i += 3) {
    sum += 3 * Number(rtn[i]) + 7 * Number(rtn[i + 2]) + Number(rtn[i + 1]);
  }
  return sum % 10 === 0;
}

/**
 * A valid routing number the broken checksum rejects (~80% of them), so every "rejected" line
 * names a number an engineer can verify by hand is actually fine.
 */
function rejectedRtn(ctx: LogContext): string {
  for (let i = 0; i < 20; i++) {
    const rtn = ctx.routingNumber();
    if (!passesSwappedChecksum(rtn)) return rtn;
  }
  return '021000021';
}

/** A valid routing number that still passes the broken checksum (~20% of them). */
function acceptedRtn(ctx: LogContext): string {
  for (let i = 0; i < 30; i++) {
    const rtn = ctx.routingNumber();
    if (passesSwappedChecksum(rtn)) return rtn;
  }
  return '041215032';
}

function batchId(ctx: LogContext): string {
  return `B${yyyymmdd(ctx.now)}-${String(ctx.rng.int(1, 9999)).padStart(4, '0')}`;
}

function achRejectStack(message: string): string {
  return javaStack({
    type: 'com.keybank.ach.validation.EntryValidator$InvalidEntryException',
    message,
    frames: [
      javaFrame(
        'com.keybank.ach.validation.EntryValidator',
        'validate',
        lineOf(ACH_ENTRY_VALIDATOR, 'if (!rdfi.valid()) {') + 1,
      ),
      javaFrame(
        'com.keybank.ach.batch.BatchAssemblyService',
        'assemble',
        lineOf(ACH_BATCH_ASSEMBLY, 'validator.validate(in.batchId(), entry);'),
      ),
      'java.base/java.util.ArrayList.forEach(ArrayList.java:1596)',
      javaFrame(
        'com.keybank.ach.batch.BatchAssemblyService',
        'onInstructions',
        lineOf(ACH_BATCH_ASSEMBLY, 'messages.forEach(this::assemble);'),
      ),
      ...springKafkaBatchFrames(),
    ],
  });
}

export const abaChecksumCascade: ScenarioDefinition = {
  id: 'aba-checksum-cascade',
  title: 'ACH, wire and bill pay rejecting valid routing numbers',
  kind: 'cascade',
  summary:
    'Outbound ACH batches are being held, wires are rejected at validation and customers cannot add bill payees, all citing invalid routing numbers that look perfectly normal.',
  answerKey: {
    rootCause:
      'routing-directory-service (ABA) MR "Optimize ABA checksum validation" unrolled the check-digit loop and swapped two weights: it computes 3a + 7c + b per digit group instead of 3a + 7b + c. About 80% of valid routing numbers now fail the checksum, so ABA answers 200 {valid:false, reason:CHECKSUM_MISMATCH}. Fix: restore weights 3-7-1.',
    culpritTla: 'ABA',
    affectedTlas: ['ACH', 'WIR', 'BPY', 'PAY'],
    whyItLooksGreen:
      'ABA returns HTTP 200 for every validation and logs results at INFO; "valid=false" is a normal business answer. The MR replaced the published routing number test vectors with a property test (exactly one check digit per prefix) that holds for any weights, so CI passed.',
  },
  badMr: {
    project: ABA_REPO,
    title: 'Optimize ABA checksum validation',
    description: `## Why
ACH file validation spends ~11% of CPU in \`isValidAbaChecksum\` during the same-day ACH windows (flame graph in PERF-311): a regex test plus nine \`Number()\` conversions per entry, ~1.4M entries/day.

## What
- Replace regex + \`Number()\` with \`charCodeAt\` arithmetic and process digits in weight groups of three
- Replace the hand-maintained list of published routing numbers with a property test: any 8-digit prefix has exactly one valid check digit. Better coverage, no list to maintain.

## Results
Micro-benchmark, 10M calls: 412 ms -> 97 ms (4.2x). No API changes.`,
    author: dev('ABA', 1),
    approvers: [dev('ABA', 3)],
    mergedBy: dev('ABA', 1),
    sourceBranch: 'perf/PERF-311-checksum-hot-path',
    labels: ['performance'],
    openedMinutesAgo: 5 * 60,
    edits: [
      {
        path: ABA_PATHS.checksum,
        find: ABA_CHECKSUM_ORIGINAL_BLOCK,
        replace: ABA_CHECKSUM_OPTIMIZED_BLOCK,
      },
      { path: ABA_PATHS.checksumTest, content: ABA_CHECKSUM_TEST_BAD },
    ],
  },
  fix: {
    title: 'Fix ABA check digit weights (3-7-1) in optimized checksum',
    description: `## Why
The PERF-311 MR ("Optimize ABA checksum validation") swapped the weights of the 2nd and 3rd digit in each group (\`3 * a + 7 * c + b\`). The ABA routine is 3-7-1, so roughly 80% of valid routing numbers have been rejected with \`CHECKSUM_MISMATCH\` since the deploy (ACH batches held, wires and payee adds rejected).

## Change
- \`sum += 3 * a + 7 * b + c\`
- Restore the published routing number vectors next to the property test (the property test passes for any weights, which is how this got through CI)`,
    edits: [
      {
        path: ABA_PATHS.checksum,
        find: ABA_BAD_SUM_LINE,
        replace: '    sum += 3 * a + 7 * b + c;',
      },
      { path: ABA_PATHS.checksumTest, find: ABA_FIX_TEST_FIND, replace: ABA_FIX_TEST_REPLACE },
    ],
    files: [ABA_PATHS.checksum],
    isFixed: abaIsFixed,
  },
  faultOnsetSec: 20,
  culpritSignals: {
    ratePerSec: 4,
    templates: [
      tpl(
        'INFO',
        (ctx) => {
          const rtn = rejectedRtn(ctx);
          const caller = ctx.rng.weighted(CALLERS);
          return nodeLog(ctx, {
            message: `routing validation result rtn=${rtn} valid=false reason=CHECKSUM_MISMATCH caller=${caller}`,
            http: {
              method: 'GET',
              url: `https://aba.internal.keybank.example/v1/routing-numbers/${rtn}/validate`,
              status: 200,
              latencySec: latency(ctx, 0.001, 0.004),
            },
            fields: { rtn, valid: false, reason: 'CHECKSUM_MISMATCH', caller },
          });
        },
        4,
      ),
      tpl('INFO', (ctx) => {
        const rtn = acceptedRtn(ctx);
        const caller = ctx.rng.weighted(CALLERS);
        return nodeLog(ctx, {
          message: `routing validation result rtn=${rtn} valid=true caller=${caller}`,
          http: {
            method: 'GET',
            url: `https://aba.internal.keybank.example/v1/routing-numbers/${rtn}/validate`,
            status: 200,
            latencySec: latency(ctx, 0.001, 0.004),
          },
          fields: { rtn, valid: true, caller },
        });
      }),
    ],
  },
  impacts: [
    {
      tla: 'ACH',
      startAfterSec: 0,
      ratePerSec: 4,
      templates: [
        tpl(
          'ERROR',
          (ctx) => {
            const rtn = rejectedRtn(ctx);
            const batch = batchId(ctx);
            const trace = `${ODFI}${String(ctx.rng.int(1, 9_999_999)).padStart(7, '0')}`;
            const message = `Entry ${trace} in batch ${batch} rejected: RDFI routing number ${rtn} failed ABA validation (CHECKSUM_MISMATCH)`;
            return javaLog(ctx, {
              logger: 'com.keybank.ach.batch.BatchAssemblyService',
              thread: `org.springframework.kafka.KafkaListenerEndpointContainer#0-${ctx.rng.int(0, 3)}-C-1`,
              message: `ACH entry rejected code=INVALID_RDFI_ROUTING trace=${trace} batch=${batch}`,
              error: {
                type: 'com.keybank.ach.validation.EntryValidator$InvalidEntryException',
                message,
                stack_trace: achRejectStack(message),
              },
              fields: {
                rdfiRoutingNumber: rtn,
                account: ctx.account(),
                amount: ctx.amount(),
                secCode: ctx.rng.pick(['PPD', 'PPD', 'WEB', 'CCD']),
              },
            });
          },
          3,
        ),
        tpl('WARNING', (ctx) => {
          const total = ctx.rng.int(24, 180);
          const rejected = Math.round(total * ctx.rng.float(0.72, 0.86));
          const batch = batchId(ctx);
          return javaLog(ctx, {
            logger: 'com.keybank.ach.batch.BatchAssemblyService',
            thread: `org.springframework.kafka.KafkaListenerEndpointContainer#0-${ctx.rng.int(0, 3)}-C-1`,
            message: `Batch ${batch} held for operations review: ${rejected} of ${total} entries rejected (company=${ctx.rng.pick(['1341234567', '1349876543', '9KEYPAYRLL', '1340551234'])})`,
            fields: { batchId: batch, rejected, total },
          });
        }),
      ],
    },
    {
      tla: 'WIR',
      startAfterSec: 10,
      ratePerSec: 1.5,
      templates: [
        tpl('ERROR', (ctx) => {
          const rtn = rejectedRtn(ctx);
          const wireId = `WT${yyyymmdd(ctx.now)}${String(ctx.rng.int(1, 999_999)).padStart(6, '0')}`;
          const amount = ctx.amount();
          const channel = ctx.rng.pick(['OLB', 'BRANCH', 'TREASURY', 'PAY']);
          return javaLog(ctx, {
            logger: 'com.keybank.wir.validation.BeneficiaryBankValidator',
            message: `Wire ${wireId} rejected: beneficiary bank ABA ${rtn} failed validation (CHECKSUM_MISMATCH) amount=${amount} channel=${channel}`,
            http: {
              method: 'POST',
              url: 'https://wire-transfer-service.internal.keybank.example/v1/wires',
              status: 422,
              latencySec: latency(ctx, 0.02, 0.15),
            },
            fields: { wireId, beneficiaryBankAba: rtn, code: 'INVALID_BENEFICIARY_BANK' },
          });
        }),
      ],
    },
    {
      tla: 'BPY',
      startAfterSec: 15,
      ratePerSec: 1.5,
      templates: [
        tpl(
          'WARNING',
          (ctx) => {
            const rtn = rejectedRtn(ctx);
            return nodeLog(ctx, {
              message: `payee validation failed: routing number ${rtn} rejected by routing-directory-service (CHECKSUM_MISMATCH)`,
              http: {
                method: 'POST',
                url: 'https://billpay-service.internal.keybank.example/v1/payees',
                status: 422,
                latencySec: latency(ctx, 0.01, 0.08),
              },
              fields: { routingNumber: rtn, reason: 'CHECKSUM_MISMATCH' },
            });
          },
          2,
        ),
        tpl('ERROR', (ctx) => {
          const rtn = rejectedRtn(ctx);
          return nodeLog(ctx, {
            message: `scheduled payment SP-${ctx.rng.int(100_000, 999_999)} failed: payee routing number ${rtn} rejected by routing-directory-service (CHECKSUM_MISMATCH)`,
            fields: { routingNumber: rtn, amount: ctx.amount(), job: 'scheduled-payments' },
          });
        }),
      ],
    },
    {
      tla: 'PAY',
      startAfterSec: 20,
      ratePerSec: 1.5,
      templates: [
        tpl(
          'ERROR',
          (ctx) => {
            const pid = paymentId(ctx);
            const rtn = rejectedRtn(ctx);
            return javaLog(ctx, {
              logger: 'com.keybank.pay.service.PaymentOrchestrator',
              message: `Payment ${pid} failed at rail=ACH: entry rejected by ach-origination (INVALID_RDFI_ROUTING, RDFI ${rtn})`,
              thread: `pay-rail-${ctx.rng.int(1, 16)}`,
              fields: { paymentId: pid, rail: 'ACH', amount: ctx.amount() },
            });
          },
          2,
        ),
        tpl('ERROR', (ctx) => {
          const pid = paymentId(ctx);
          return javaLog(ctx, {
            logger: 'com.keybank.pay.service.PaymentOrchestrator',
            message: `Payment ${pid} failed at rail=WIRE: wire-transfer-service returned 422 INVALID_BENEFICIARY_BANK`,
            thread: `pay-rail-${ctx.rng.int(1, 16)}`,
            fields: { paymentId: pid, rail: 'WIRE', amount: ctx.amount() },
          });
        }),
      ],
    },
  ],
  fanout: [
    {
      upstreamTla: 'ABA',
      startAfterSec: 25,
      ratePerSec: 0.5,
      templates: perStack({
        java: (app) => [
          tpl('WARNING', (ctx) => {
            const rtn = rejectedRtn(ctx);
            return javaLog(ctx, {
              logger: `${javaPackage(app)}.client.RoutingDirectoryClient`,
              message: `Routing number ${rtn} failed ABA validation (CHECKSUM_MISMATCH); rejecting instruction`,
              http: {
                method: 'POST',
                url: internalUrl(app, '/v1/settlements'),
                status: 422,
                latencySec: latency(ctx, 0.01, 0.1),
              },
            });
          }),
        ],
        node: (app) => [
          tpl('WARNING', (ctx) => {
            const rtn = rejectedRtn(ctx);
            return nodeLog(ctx, {
              message: `routing number ${rtn} rejected by routing-directory-service (CHECKSUM_MISMATCH)`,
              http: {
                method: 'POST',
                url: internalUrl(app, '/v1/settlements'),
                status: 422,
                latencySec: latency(ctx, 0.01, 0.1),
              },
            });
          }),
        ],
        python: (app) => [
          tpl('WARNING', (ctx) => {
            const rtn = rejectedRtn(ctx);
            return pyLog(ctx, {
              logger: `${pyPackage(app)}.settlement`,
              message: 'settlement account rejected: routing number failed ABA validation',
              fields: {
                routing_number: rtn,
                reason: 'CHECKSUM_MISMATCH',
                merchant_ref: ctx.requestId(),
              },
            });
          }),
        ],
      }),
    },
  ],
  alerts: [
    moogsoftAlert({
      atSec: 45,
      repeatEverySec: 60,
      tla: 'ACH',
      severity: 'critical',
      manager: 'GCP Monitoring',
      check: 'ach_entry_rejection_rate',
      description: 'ACH entry rejection rate 79.6% on ach-origination (threshold 1%, 5m window)',
      custom: {
        metric: 'custom.googleapis.com/ach/entry_rejection_ratio',
        observed_pct: 79.6,
        threshold_pct: 1,
      },
    }),
    moogsoftAlert({
      atSec: 60,
      repeatEverySec: 90,
      tla: 'WIR',
      severity: 'major',
      manager: 'AppDynamics',
      check: 'error_rate',
      description: 'Wire validation failure rate 81% on wire-transfer-service (baseline 0.2%)',
      custom: { appd_application: 'WIR-Prod', observed_pct: 81, baseline_pct: 0.2 },
    }),
    moogsoftAlert({
      atSec: 75,
      repeatEverySec: 90,
      tla: 'PAY',
      severity: 'major',
      manager: 'GCP Monitoring',
      check: 'failed_payment_rate',
      description: 'Failed payment rate 17.3% on payments-api (threshold 2%, 10m window)',
      custom: {
        metric: 'custom.googleapis.com/payments/failed_ratio',
        observed_pct: 17.3,
        threshold_pct: 2,
      },
    }),
    moogsoftAlert({
      atSec: 90,
      repeatEverySec: 120,
      tla: 'BPY',
      severity: 'minor',
      manager: 'AppDynamics',
      check: 'http_4xx_rate',
      description: 'HTTP 422 rate 18% on billpay-service POST /v1/payees (baseline 1%)',
      custom: { appd_application: 'BPY-Prod', observed_pct: 18, baseline_pct: 1 },
    }),
  ],
  redHerrings: [
    {
      atSec: 8,
      kind: 'merge',
      project: ACH_REPO,
      title: 'Add same-day ACH window 4 schedule (feature flag off)',
      description:
        'Config only, behind `ach.sameday.window4.enabled` (false). Nacha proposal for a 4th same-day window; enabling is tracked in ACH-902.',
      author: dev('ACH', 0),
      mergedBy: dev('ACH', 2),
      sourceBranch: 'feature/ACH-902-sameday-window-4',
      labels: ['config', 'feature-flag'],
      edits: [
        {
          path: 'src/main/resources/sameday-windows.yml',
          content: `# Same-day ACH submission windows (Eastern time). Window 4 stays disabled until ACH-902.
ach:
  sameday:
    windows:
      - { id: 1, submit-by: "10:15", settle: "13:00" }
      - { id: 2, submit-by: "14:15", settle: "17:00" }
      - { id: 3, submit-by: "16:30", settle: "18:00" }
    window4:
      enabled: false
      submit-by: "18:15"
      settle: "19:30"
`,
        },
      ],
    },
    {
      atSec: 22,
      kind: 'commit',
      project: WIR_REPO,
      title: 'Load 2027 Fedwire holiday calendar',
      author: dev('WIR', 2),
      edits: [
        {
          path: 'src/main/resources/calendars/fedwire-holidays-2027.csv',
          content: `date,name
2027-01-01,New Year's Day
2027-01-18,Martin Luther King Jr. Day
2027-02-15,Washington's Birthday
2027-05-31,Memorial Day
2027-06-18,Juneteenth (observed)
2027-07-05,Independence Day (observed)
2027-09-06,Labor Day
2027-10-11,Columbus Day
2027-11-11,Veterans Day
2027-11-25,Thanksgiving Day
2027-12-24,Christmas Day (observed)
`,
        },
      ],
    },
  ],
};
