import { getPerson, PERSONAS } from '@sim/world';
import { javaLog } from '../logs';
import { DEP_REPO } from '../repos/dep';
import {
  TLR_APPLICATION_YML_BAD,
  TLR_BAD_CONTENT,
  TLR_BUSINESS_DAY_BLOCK,
  TLR_BUSINESS_DAY_BLOCK_BAD,
  TLR_HOLIDAYS,
  TLR_PATHS,
  TLR_REPO,
} from '../repos/tlr';
import type { LogContext, ScenarioDefinition } from '../types';
import {
  branchStaff,
  dev,
  easternDate,
  latency,
  serviceDeskAnalyst,
  stripCComments,
  stripHashComments,
  tpl,
  uuid,
} from '../util';

// ---------------------------------------------------------------------------
// Fix detection
// ---------------------------------------------------------------------------

const UTC_ZONE = /^(UTC|GMT|Z|Zulu|Etc\/UTC|Etc\/GMT|UCT|Universal)$/i;

/** A key in the `teller.business-day` block of application.yml (indentation-based, no YAML parser). */
function businessDayValue(yml: string, key: string): string | undefined {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^\s*business-day:\s*$/.test(l));
  if (start < 0) return undefined;
  const indent = (l: string) => l.length - l.trimStart().length;
  const blockIndent = indent(lines[start]!);
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (indent(line) <= blockIndent) break;
    const m = line.match(new RegExp(`^\\s*${key}:\\s*["']?([\\w/:+-]+)`));
    if (m) return m[1];
  }
  return undefined;
}

/** Minutes after midnight for "HH:MM". */
function minutesOf(hhmm: string | undefined): number | undefined {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** True when the business day is computed in the bank's (US) business time zone again. */
function businessZoneOk(service: string, yml: string, props: string): boolean {
  // A zone hard-coded in BusinessDateService wins over configuration.
  if (/ZoneOffset\.UTC|ZoneId\.of\(\s*"(UTC|GMT|Z|Etc\/UTC)"\s*\)/.test(service)) return false;
  if (/ZoneId\.of\(\s*"(America\/|US\/)/.test(service)) return true;
  const zone = businessDayValue(yml, 'timezone') ?? props.match(/timezone\s*=\s*"([^"]+)"/)?.[1];
  return zone !== undefined && !UTC_ZONE.test(zone);
}

/**
 * True when the posting cutoff is a real end-of-day cutoff again. "00:00" (the bad MR) makes
 * every transaction post to the next business day; anything from noon on is a plausible cutoff.
 */
function cutoffOk(yml: string, props: string): boolean {
  const configured = minutesOf(businessDayValue(yml, 'posting-cutoff'));
  const fallback = props.match(/postingCutoff\s*=\s*LocalTime\.of\(\s*(\d+)\s*,\s*(\d+)/);
  const cutoff =
    configured ?? (fallback ? Number(fallback[1]) * 60 + Number(fallback[2]) : undefined);
  return cutoff !== undefined && cutoff >= 12 * 60;
}

/** Fixed when the business date uses the Eastern business day and a sane posting cutoff. */
function tlrIsFixed(files: Record<string, string | null>): boolean {
  const service = stripCComments(files[TLR_PATHS.businessDateService] ?? '');
  const yml = stripHashComments(files[TLR_PATHS.applicationYml] ?? '');
  const props = stripCComments(files[TLR_PATHS.properties] ?? '');
  return businessZoneOk(service, yml, props) && cutoffOk(yml, props);
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const BRANCHES: (readonly [readonly [string, string], number])[] = [
  [['0101', 'Cleveland Main Branch'], 5],
  [['0410', 'Buffalo Elmwood Branch'], 3],
  [['0114', 'Lakewood Branch'], 1],
  [['0122', 'Akron Highland Square Branch'], 1],
  [['0433', 'Albany Western Ave Branch'], 1],
  [['0457', 'Syracuse Erie Blvd Branch'], 1],
];

const HOLIDAYS = new Set<string>(TLR_HOLIDAYS);

/** First business day strictly after `isoDate` (weekends and TLR holidays skipped). */
function nextBusinessDay(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (
    d.getUTCDay() === 0 ||
    d.getUTCDay() === 6 ||
    HOLIDAYS.has(d.toISOString().slice(0, 10))
  );
  return d.toISOString().slice(0, 10);
}

/**
 * What BusinessDateService computes with the bad config: the UTC date, always past the 00:00
 * cutoff, so the next business day after it. `today` is the open (Eastern) business date that
 * drawer sessions and GL use. Matches the code at any time of day.
 */
function dates(ctx: LogContext) {
  return {
    today: easternDate(ctx.now),
    tomorrow: nextBusinessDay(ctx.now.toISOString().slice(0, 10)),
  };
}

function drawer(ctx: LogContext) {
  return `D-${String(ctx.rng.int(1, 12)).padStart(2, '0')}`;
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

const caller = getPerson(PERSONAS.branchManager);
const headTeller = getPerson(PERSONAS.headTeller);
// More branches calling about the same problem, so the agent has duplicates to group under one
// parent incident. Each sees a different symptom and one blames the receipt printer.
const lakewood = branchStaff('Lakewood Branch', ['Head Teller', 'Teller']);
const akron = branchStaff('Akron Highland Square Branch', [
  'Assistant Branch Manager',
  'Branch Manager',
]);

export const tlrBusinessDateHelpdesk: ScenarioDefinition = {
  id: 'tlr-business-date-helpdesk',
  title: 'Branch drawers out of balance',
  kind: 'helpdesk',
  summary:
    "Branches start calling the service desk one after another: teller receipts show tomorrow's date and drawers will not balance. Monitoring is quiet.",
  answerKey: {
    rootCause:
      'teller-workstation-api (TLR) MR "Use UTC consistently for transaction timestamps" also moved the business day to UTC: teller.business-day.timezone America/New_York -> UTC and posting-cutoff "19:00" -> "00:00" ("19:00 Eastern = 00:00 UTC"). BusinessDateService posts to the next business day when the time is not before the cutoff, and no time is before midnight, so every teller transaction posts to the next business day: drawer sessions (today) no longer match their transactions, drawers do not balance, and GL rejects the future-dated postings. Fix: restore America/New_York and the 19:00 cutoff (keep UTC timestamps). Restoring only the time zone leaves the 00:00 cutoff, which still posts everything to the next day.',
    culpritTla: 'TLR',
    affectedTlas: ['TLR', 'GLD'],
    whyItLooksGreen:
      'Nothing errors: TLR returns 200 for every transaction and only logs WARNINGs (business date mismatch, drawer variance, GL posting deferred); GLD logs WARNING rejections. No alert rule fires, so the first signal is a phone call. Unit tests build BusinessDayProperties in code (America/New_York, default 19:00 cutoff) and never read application.yml, so CI passed with the production config set to UTC and 00:00.',
  },
  badMr: {
    project: TLR_REPO,
    title: 'Use UTC consistently for transaction timestamps',
    description: `## Problem
\`teller_transaction.posted_at\` is filled from \`LocalDateTime.now()\`, so its meaning depends on the pod's time zone. Audit finding AUD-4471 found mixed offsets after the GKE node pool migration.

## Change
- \`posted_at\` is an \`Instant\` (UTC); Hibernate \`jdbc.time_zone: UTC\`
- Jackson serializes timestamps in UTC
- The business-day clock uses the same zone (\`teller.business-day.timezone: UTC\`) so business dates and timestamps can't disagree; the 19:00 Eastern posting cutoff is converted to UTC (\`posting-cutoff: "00:00"\`)
- Tests updated for \`Instant\`

Implements Enterprise Architecture Standard EAS-207 ("store and process all timestamps in UTC").`,
    author: dev('TLR', 3),
    approvers: [dev('TLR', 1)],
    mergedBy: dev('TLR', 1),
    sourceBranch: 'fix/AUD-4471-utc-timestamps',
    labels: ['audit', 'tech-debt'],
    openedMinutesAgo: 4 * 24 * 60,
    edits: [
      { path: TLR_PATHS.applicationYml, content: TLR_APPLICATION_YML_BAD },
      { path: TLR_PATHS.transaction, content: TLR_BAD_CONTENT.transaction },
      { path: TLR_PATHS.transactionService, content: TLR_BAD_CONTENT.transactionService },
      { path: TLR_PATHS.transactionServiceTest, content: TLR_BAD_CONTENT.transactionServiceTest },
    ],
  },
  fix: {
    title: 'Restore America/New_York business day for teller postings',
    description: `## Why
The AUD-4471 MR ("Use UTC consistently for transaction timestamps") set \`teller.business-day.timezone: UTC\` and "converted" the posting cutoff to \`00:00\`. \`BusinessDateService\` posts to the next business day when the time is not before the cutoff, and nothing is before midnight, so every teller transaction posts to the next business day. Drawer sessions no longer match their transactions (drawers out of balance) and GL rejects the postings as \`FUTURE_BUSINESS_DATE\`. The business day is a bank concept, not a timestamp, and the cutoff only works in local time.

## Change
- \`teller.business-day.timezone: America/New_York\`, \`posting-cutoff: "19:00"\`
- Timestamps stay UTC (\`Instant\`, Hibernate/Jackson UTC), which was the point of the original MR

Postings deferred to the GL retry queue will be re-sent by the EOD sweep with the correct business date.`,
    edits: [
      {
        path: TLR_PATHS.applicationYml,
        find: TLR_BUSINESS_DAY_BLOCK_BAD,
        replace: `    # Business day follows branch operations (Eastern); timestamps stay UTC (EAS-207).\n${TLR_BUSINESS_DAY_BLOCK}`,
      },
    ],
    files: [TLR_PATHS.applicationYml, TLR_PATHS.businessDateService, TLR_PATHS.properties],
    isFixed: tlrIsFixed,
  },
  faultOnsetSec: 30,
  impacts: [
    {
      tla: 'TLR',
      startAfterSec: 0,
      ratePerSec: 1.2,
      templates: [
        tpl(
          'WARNING',
          (ctx) => {
            const { today, tomorrow } = dates(ctx);
            const [branch, branchName] = ctx.rng.weighted(BRANCHES);
            const d = drawer(ctx);
            return javaLog(ctx, {
              logger: 'com.keybank.tlr.service.TellerTransactionService',
              message: `Transaction business date ${tomorrow} differs from drawer session business date ${today} (branch=${branch} drawer=${d}); posting to ${tomorrow}`,
              http: {
                method: 'POST',
                url: 'https://teller.internal.keybank.example/v1/teller/transactions',
                status: 200,
                latencySec: latency(ctx, 0.04, 0.18),
              },
              fields: {
                branch,
                branchName,
                drawer: d,
                txnType: ctx.rng.pick([
                  'CASH_DEPOSIT',
                  'CASH_DEPOSIT',
                  'CHECK_DEPOSIT',
                  'CASH_WITHDRAWAL',
                  'LOAN_PAYMENT',
                ]),
                account: ctx.account(),
                amount: ctx.amount(),
              },
            });
          },
          3,
        ),
        tpl(
          'WARNING',
          (ctx) => {
            const { today, tomorrow } = dates(ctx);
            const txn = `TT-${uuid(ctx)}`;
            return javaLog(ctx, {
              logger: 'com.keybank.tlr.client.GlPostingClient',
              message: `GL posting rejected for txn ${txn} (422): {"code":"FUTURE_BUSINESS_DATE","message":"Business date ${tomorrow} is after open business date ${today}"}; queued for EOD sweep`,
              fields: { txnId: txn },
            });
          },
          2,
        ),
        tpl('WARNING', (ctx) => {
          const { today } = dates(ctx);
          const [branch, branchName] = ctx.rng.weighted(BRANCHES);
          const expected = ctx.rng.int(400_000, 2_400_000);
          const missing = ctx.rng.int(60_000, 640_000);
          return javaLog(ctx, {
            logger: 'com.keybank.tlr.service.DrawerBalancingService',
            message: `Drawer out of balance branch=${branch} drawer=${drawer(ctx)} businessDate=${today} expected=${money(expected)} counted=${money(expected + missing)} variance=${money(missing)}`,
            http: {
              method: 'POST',
              url: `https://teller.internal.keybank.example/v1/teller/drawers/${drawer(ctx)}/balance`,
              status: 200,
              latencySec: latency(ctx, 0.03, 0.12),
            },
            fields: { branch, branchName },
          });
        }),
      ],
    },
    {
      tla: 'GLD',
      startAfterSec: 5,
      ratePerSec: 0.6,
      templates: [
        tpl('WARNING', (ctx) => {
          const { today, tomorrow } = dates(ctx);
          return javaLog(ctx, {
            logger: 'com.keybank.gld.posting.BusinessDateValidator',
            message: `Posting rejected: future business date ${tomorrow} (open business date ${today}) source=TLR journal=TT-${uuid(ctx)}`,
            http: {
              method: 'POST',
              url: 'https://gl-posting-service.internal.keybank.example/v1/postings',
              status: 422,
              latencySec: latency(ctx, 0.005, 0.03),
            },
            fields: { code: 'FUTURE_BUSINESS_DATE', ledger: 'PRIMARY' },
          });
        }),
      ],
    },
  ],
  alerts: [],
  helpdesk: [
    {
      atSec: 120,
      incident: {
        short_description:
          'Teller transactions posting with next business date, drawers out of balance - Cleveland Main',
        description: `Caller: ${caller.name}, ${caller.title} - ${caller.location}
Callback: ${caller.phone}

Issue:
Caller reports teller transactions are posting with tomorrow's date. Customer receipts printed from Teller Workstation show the next business day as the effective date, and the electronic journal shows the same. Two tellers ran a mid-day drawer balance and both drawers show out of balance in the system. The physical cash count matches their manual tape, so the system total appears to be missing the recent transactions.

Customer impact:
- Customers making cash deposits are being told funds will not be available until tomorrow. At least one customer complained at the window.
- Branch cannot complete drawer balancing; caller is concerned about end-of-day close.

Scope:
- At least 2 teller windows at Cleveland Main (windows 3 and 7).
- Caller says ${headTeller.name} (${headTeller.title}, ${headTeller.location}) reported the same thing on the regional branch call.
- Teller Workstation is otherwise working: customer lookup, cash in/out and receipts all work.

Troubleshooting performed:
- Confirmed date/time on the teller PCs is correct (today's date).
- Had the teller log out and back in to Teller Workstation. Issue persists.
- Restarted Teller Workstation on the window 7 PC. Issue persists.
- Checked the IT status page: no posted outages for branch systems.

Requested action:
Please route to the team that supports Teller Workstation / teller transaction posting. Branch needs this resolved before end-of-day balancing.`,
        caller: PERSONAS.branchManager,
        opened_by: PERSONAS.serviceDeskAnalyst,
        contact_type: 'phone',
        category: 'application',
        subcategory: 'Branch systems',
        impact: 2,
        urgency: 1,
        assignment_group: 'IT Service Desk',
      },
    },
    {
      atSec: 165,
      incident: {
        short_description:
          "Receipt printer printing tomorrow's date on deposit receipts - Lakewood",
        description: `Caller: ${lakewood.name}, ${lakewood.title} - ${lakewood.location}
Callback: ${lakewood.phone}

Issue:
Deposit receipts from the window 2 receipt printer show tomorrow's date. Caller thinks the printer clock is wrong. Customer noticed it and asked whether the deposit would post today.

Troubleshooting performed:
- Power-cycled the receipt printer. Still prints tomorrow's date.
- Printed a receipt from window 4 as well: same date.

Requested action:
Send a technician to check the receipt printers, or tell us how to reset the date.`,
        caller: lakewood.username,
        opened_by: serviceDeskAnalyst(0, PERSONAS.serviceDeskAnalyst),
        contact_type: 'phone',
        category: 'hardware',
        subcategory: 'Receipt printer',
        impact: 3,
        urgency: 2,
        assignment_group: 'IT Service Desk',
      },
    },
    {
      atSec: 210,
      incident: {
        short_description: "Today's teller deposits showing as next-day in the electronic journal",
        description: `From: ${headTeller.name} <${headTeller.email}>, ${headTeller.title} - ${headTeller.location}

Hi Service Desk,

For the last hour or so every transaction in the Teller Workstation electronic journal has tomorrow's business date. Customers making deposits see "available tomorrow" on their receipt. I mentioned it on the regional branch call and Cleveland Main sees the same thing.

Our drawer totals in the system don't match the cash count either, so we can't start balancing.

Thanks,
${headTeller.firstName}`,
        caller: PERSONAS.headTeller,
        opened_by: serviceDeskAnalyst(1, PERSONAS.serviceDeskAnalyst),
        contact_type: 'email',
        category: 'application',
        subcategory: 'Branch systems',
        impact: 2,
        urgency: 2,
        assignment_group: 'IT Service Desk',
      },
    },
    {
      atSec: 270,
      incident: {
        short_description:
          'Cannot balance teller drawers, system totals missing transactions - Akron',
        description: `Caller: ${akron.name}, ${akron.title} - ${akron.location}
Callback: ${akron.phone}

Issue:
Started end-of-day prep early. All three drawers are out of balance in Teller Workstation: the system totals are short by exactly the transactions done in the last hour or two. Those transactions show up when the teller filters by tomorrow's date.

Customer impact:
- Branch cannot close the day.
- Two customers asked why their receipt shows tomorrow's date.

Requested action:
Urgent: branch closes in under two hours.`,
        caller: akron.username,
        opened_by: PERSONAS.serviceDeskAnalyst,
        contact_type: 'chat',
        category: 'application',
        subcategory: 'Branch systems',
        impact: 2,
        urgency: 1,
        assignment_group: 'IT Service Desk',
      },
    },
  ],
  redHerrings: [
    {
      atSec: 20,
      kind: 'merge',
      project: 'keybank/GLD00/gl-eod-batch',
      title: 'EOD close: run subledger extracts in parallel',
      description:
        'Splits the subledger extract step into 4 parallel partitions by ledger range. Cuts EOD close by ~18 minutes in UAT. No change to posting rules or business date roll.',
      author: dev('GLD', 0),
      mergedBy: dev('GLD', 4),
      sourceBranch: 'perf/GLD-771-parallel-extract',
      labels: ['eod', 'performance'],
      edits: [
        {
          path: 'src/main/resources/eod/subledger-extract.yml',
          content: `# EOD subledger extract partitioning (GLD-771).
eod:
  subledger-extract:
    partitions: 4
    partition-key: ledger_range
    max-parallel: 4
    fail-fast: true
`,
        },
      ],
    },
    {
      atSec: 40,
      kind: 'commit',
      project: DEP_REPO,
      title: 'Update hold reason descriptions for statement redesign',
      author: dev('DEP', 2),
      edits: [
        {
          path: 'src/main/resources/messages/hold-reasons_en.properties',
          content: `# Customer-facing hold reason descriptions (statement redesign, DEP-1310).
hold.reason.LARGE_DEPOSIT=Large deposit hold
hold.reason.NEW_ACCOUNT=New account hold
hold.reason.REDEPOSITED_CHECK=Redeposited check hold
hold.reason.REASONABLE_DOUBT=Hold pending verification
hold.reason.LEGAL=Legal order hold
`,
        },
      ],
    },
  ],
};
