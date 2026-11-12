import { URLS } from '@sim/contracts';
import {
  type CloseCode,
  CONTACT_TYPE_LABELS,
  type ContactType,
  type FieldChange,
  IMPACT_LABELS,
  type ImpactUrgency,
  type IncidentState,
  PRIORITY_LABELS,
  priorityFor,
  STATE_LABELS,
} from '@sim/contracts/servicenow';
import {
  type App,
  PAST_MAJOR_INCIDENTS,
  type PastMajorIncident,
  PERSONAS,
  type Person,
  Rng,
  SHARED_GROUP_IDS,
  sysId,
} from '@sim/world';
import { type Directory, SYSTEM_USER } from './directory';
import {
  emptyResolution,
  FIRST_NUMBER,
  type IdGen,
  type IncidentRecord,
  incidentNumber,
  type JournalRecord,
} from './model';

/**
 * Deterministic incident history: ~200 incidents over the last 90 days, mostly resolved or
 * closed, with a dozen low/medium priority incidents still open, plus the past major incidents
 * (`PAST_MAJOR_INCIDENTS`). Content is stable across runs; timestamps are
 * relative to `now` (process start or the last reset).
 */

const TOTAL = 200;
const OPEN_STATES: IncidentState[] = [
  'new',
  'new',
  'new',
  'new',
  'in_progress',
  'in_progress',
  'in_progress',
  'in_progress',
  'in_progress',
  'on_hold',
  'on_hold',
  'on_hold',
];

type SeedCategory =
  | 'application'
  | 'network'
  | 'database'
  | 'access'
  | 'hardware'
  | 'batch_job'
  | 'performance';

/** Where the incident is routed instead of the app's own support group. */
type GroupHint = 'network' | 'dba' | 'cloud' | 'service_desk' | 'iam' | 'app';

interface Ctx {
  rng: Rng;
  app: App;
  tla: string;
  tlaLower: string;
  name: string;
  service: string;
  ns: string;
  cluster: string;
  up?: App;
  down?: App;
  branch: string;
  callerFirst: string;
  feature: string;
  job: string;
  db: string;
  oracleDb: string;
  pgDb: string;
  version: string;
  pct: number;
  prop: string;
  exception: string;
  host: string;
  ip: string;
  vendor: string;
  dept: string;
  change: string;
  atm: string;
  secs: string;
  station: number;
  /** The app is used in branches (teller, branch ops, ATM). */
  branchApp: boolean;
}

interface Story {
  short: string;
  subcategory: string;
  /** Monitoring alert text; stories with an alert are usually opened by monitoring. */
  alert?: string;
  /** Written as the problem statement; caller details are prefixed for human callers. */
  description: string;
  /** Work notes in the order they happen. The last one is usually the fix. */
  notes: string[];
  /** Work note explaining why the incident is on hold. */
  hold?: string;
  close: [CloseCode, string];
  group?: GroupHint;
  /** Prefer a branch associate as the caller. */
  branchCaller?: boolean;
  /** Only IT staff would report this (never a branch associate). */
  techCaller?: boolean;
}

type StoryFn = (c: Ctx) => Story | null;

const FEATURES = [
  'account summary',
  'transaction history',
  'statement download',
  'payment submission',
  'customer search',
  'login',
  'reporting dashboard',
  'case creation',
  'document upload',
  'limits maintenance',
];

const VENDORS = [
  'FIS',
  'Fiserv',
  'Jack Henry',
  'Visa DPS',
  'Mastercard',
  'Federal Reserve FedLine',
  'Experian',
  'Equifax',
];

const PROPS: Record<string, string[]> = {
  'java-spring': ['spring.datasource.url', 'app.ledger.base-url', 'spring.kafka.bootstrap-servers'],
  'node-ts': ['OAUTH_CLIENT_ID', 'REDIS_URL', 'UPSTREAM_BASE_URL'],
  python: ['DATABASE_URL', 'MODEL_BUCKET', 'KAFKA_BROKERS'],
};

const EXCEPTIONS: Record<string, string[]> = {
  'java-spring': [
    'NullPointerException',
    'IllegalStateException',
    'DataIntegrityViolationException',
  ],
  'node-ts': [
    "TypeError: Cannot read properties of undefined (reading 'accountId')",
    'Error: ETIMEDOUT',
  ],
  python: ["KeyError: 'customer_id'", "AttributeError: 'NoneType' object has no attribute 'get'"],
};

const STORIES: Record<SeedCategory, StoryFn[]> = {
  application: [
    (c) => ({
      short: `${c.tla} - HTTP 500 errors on ${c.feature} after release ${c.version}`,
      subcategory: 'Software defect',
      alert: `HTTP 5xx rate ${c.pct}% on ${c.service} (threshold 5%)`,
      description: `Elevated 5xx error rate on ${c.service} (${c.ns}, ${c.cluster}) shortly after release ${c.version} was deployed. Users of ${c.name} cannot complete ${c.feature}.`,
      notes: [
        `Error spike lines up with the ${c.version} rollout. Reviewing the merge requests in the release.`,
        `Stack traces show ${c.exception} in the ${c.feature} handler. Engaged the ${c.tla} dev team.`,
        `Rolled ${c.service} back to the previous image. 5xx rate back under 0.5%.`,
      ],
      hold: `Waiting on the ${c.tla} dev team to confirm the rollback can stay in place overnight.`,
      close: [
        'Resolved by change',
        `Defect in release ${c.version}: ${c.exception} in the ${c.feature} path for customers without a linked profile. Rolled back; fix scheduled for the next release.`,
      ],
    }),
    (c) => ({
      short: `${c.name}: "Unexpected error" when opening ${c.feature}`,
      subcategory: 'Data issue',
      description: `${c.feature[0]!.toUpperCase()}${c.feature.slice(1)} in ${c.name} shows "Unexpected error, please try again" for some customers. Other screens work.`,
      notes: [
        `Reproduced with the customer id provided by the caller. Logs show ${c.exception}.`,
        'Customer record is missing a mandatory preference field. Applied a data fix with an approved script.',
      ],
      hold: 'Awaiting a second customer example from the caller to confirm scope.',
      close: [
        'Solution provided',
        `A customer record with a missing preference field caused ${c.exception}. Data corrected; defect raised with the ${c.tla} team to handle nulls.`,
      ],
    }),
    (c) => ({
      short: `${c.service} pods restarting (CrashLoopBackOff) in ${c.ns}`,
      subcategory: 'Configuration',
      alert: `Pod restarts > 5 in 10m for ${c.service} on ${c.cluster}`,
      description: `Kubernetes reports repeated restarts of ${c.service} in namespace ${c.ns} on ${c.cluster}. Capacity is reduced and ${c.name} may be intermittently unavailable.`,
      notes: [
        `Container exits on startup: "Missing required property ${c.prop}".`,
        `Config map for ${c.service} was overwritten by an infrastructure pipeline run. Restored the previous version and restarted the deployment.`,
        'All replicas Running and Ready for 20 minutes.',
      ],
      close: [
        'Solution provided',
        `An infrastructure pipeline run replaced the ${c.service} config map and dropped ${c.prop}. Config map restored; pipeline changed to merge instead of replace.`,
      ],
    }),
    (c) =>
      c.up
        ? {
            short: `${c.tla} calls to ${c.up.tla} timing out`,
            subcategory: 'Integration',
            alert: `Timeouts calling ${c.up.runtime.service} from ${c.service} above 2%`,
            description: `${c.service} is logging read timeouts (5000 ms) when calling ${c.up.name} (${c.up.tla}). Requests that depend on ${c.up.tla} fail for ${c.name} users.`,
            notes: [
              `Timeouts started at the same time on every ${c.service} pod. Checking ${c.up.tla} health.`,
              `${c.up.tla} support confirmed a slow dependency on their side and recycled the affected pods.`,
              'Timeout rate back to baseline.',
            ],
            hold: `Waiting on ${c.up.tla} support to finish their investigation.`,
            close: [
              'Solution provided',
              `Upstream ${c.up.tla} responded slowly after a node pool upgrade. The ${c.up.tla} team recycled pods; ${c.tla} recovered without changes.`,
            ],
          }
        : null,
    (c) =>
      c.up
        ? {
            short: `${c.tla} - SSL handshake failures calling ${c.up.tla}`,
            subcategory: 'Certificate',
            alert: `SSLHandshakeException > 50/min on ${c.service}`,
            description: `${c.service} fails TLS handshakes to ${c.up.tla} with "PKIX path validation failed: certificate expired".`,
            notes: [
              `Client certificate for ${c.service} expired at 00:00 UTC.`,
              'Requested an emergency renewal through the certificate portal and redeployed with the new keystore.',
            ],
            close: [
              'Solution provided',
              'Expired client certificate. Renewed and redeployed; certificate added to expiry monitoring.',
            ],
          }
        : null,
  ],
  network: [
    (c) => ({
      short: `Load balancer pool member down for ${c.service}`,
      subcategory: 'Load balancer',
      alert: `F5 pool member ${c.ip}:8443 down (pool ${c.ns}-prod)`,
      description: `The F5 marks one or more ${c.service} pool members down. Remaining members carry all ${c.name} traffic.`,
      notes: [
        `F5 monitor calls /health; ${c.service} moved its health check to /actuator/health in the last release.`,
        'Updated the monitor path. All pool members up.',
      ],
      close: [
        'Solution provided',
        `F5 health monitor still pointed at the old /health path after ${c.tla} moved to /actuator/health. Monitor updated.`,
      ],
      group: 'network',
    }),
    (c) =>
      !c.branchApp
        ? null
        : {
            short: `${c.branch} - intermittent connectivity to core systems`,
            subcategory: 'WAN',
            description: `Branch staff at ${c.branch} report that ${c.name} and other core applications freeze for 30-60 seconds several times an hour.`,
            notes: [
              'Branch router shows the primary circuit flapping. Traffic is failing over to the LTE backup.',
              'Opened a ticket with the carrier for the primary circuit.',
              'Carrier replaced the faulty NTU at the branch. Circuit stable for 2 hours.',
            ],
            hold: 'Waiting on carrier dispatch to the branch (ETA tomorrow morning).',
            close: [
              'Solution provided',
              'Carrier replaced faulty equipment at the branch demarc. Primary circuit stable; LTE failover worked as designed.',
            ],
            group: 'network',
            branchCaller: true,
          },
    (c) => ({
      short: `DNS resolution failures for ${c.service}.${c.ns}.svc.cluster.local`,
      subcategory: 'DNS',
      alert: `UnknownHostException rate > 1% on ${c.service}`,
      description: `${c.service} intermittently fails to resolve in-cluster service names on ${c.cluster}.`,
      notes: [
        `CoreDNS pods on ${c.cluster} are restarting with OOMKilled.`,
        'Cloud Platform raised CoreDNS memory limits and scaled to 4 replicas.',
      ],
      close: [
        'Solution provided',
        `CoreDNS on ${c.cluster} was OOM killed under load. Memory limits increased and autoscaling enabled.`,
      ],
      group: 'cloud',
    }),
    (c) =>
      c.up
        ? {
            short: `${c.tla} unable to reach ${c.up.tla} after firewall change`,
            techCaller: true,
            subcategory: 'Firewall',
            description: `Connections from ${c.service} to ${c.up.tla} are refused since the overnight network change window.`,
            notes: [
              `Connection refused on 8443 from ${c.ns} to ${c.up.tla}. Last night's firewall change ${c.change} touched this segment.`,
              'Network added the missing rule to the policy. Connectivity restored.',
            ],
            close: [
              'Resolved by change',
              `Firewall change ${c.change} dropped the rule allowing ${c.tla} to reach ${c.up.tla} on 8443. Rule restored under an emergency change.`,
            ],
            group: 'network',
          }
        : null,
    (c) => ({
      short: `Site-to-site VPN to ${c.vendor} flapping`,
      subcategory: 'VPN',
      alert: `IPsec tunnel to ${c.vendor} down (primary)`,
      description: `The IPsec tunnel to ${c.vendor} drops every few minutes. ${c.name} transactions that go to ${c.vendor} are retrying.`,
      notes: [
        `Tunnel re-keys every few minutes; phase 2 lifetime mismatch with ${c.vendor}.`,
        `Agreed a new lifetime with the ${c.vendor} network team and updated our side.`,
      ],
      hold: `Waiting on the ${c.vendor} network team to schedule a joint change.`,
      close: [
        'Solution provided',
        `IPsec phase 2 lifetime mismatch after ${c.vendor} upgraded their concentrator. Settings aligned; tunnel stable.`,
      ],
      group: 'network',
    }),
  ],
  database: [
    (c) => ({
      short: `${c.tla} - database connection pool exhausted`,
      subcategory: 'Connection pool',
      alert: `HikariPool-1 - Connection is not available, request timed out after 30000ms (${c.service})`,
      description: `${c.service} cannot get database connections from its pool. ${c.name} requests fail with timeouts.`,
      notes: [
        `Active connections at the pool maximum (50). A long-running report query is holding sessions on ${c.db}.`,
        'DBA killed the blocking session; pool recovered.',
        'Raised a problem record to move the report to the read replica.',
      ],
      close: [
        'Workaround provided',
        `Ad hoc reporting query held connections on ${c.db}. Session killed; report to be moved to the read replica.`,
      ],
      group: c.rng.chance(0.5) ? 'dba' : 'app',
    }),
    (c) => ({
      short: `Tablespace ${c.tla}_DATA at 95% on ${c.oracleDb}`,
      subcategory: 'Capacity',
      alert: `Oracle tablespace ${c.tla}_DATA usage 95% on ${c.oracleDb}`,
      description: `Tablespace ${c.tla}_DATA on ${c.oracleDb} is close to full. Inserts will fail when it reaches 100%.`,
      notes: [
        'Growth is driven by the audit table; the purge job has not run since last month.',
        'Added a 32 GB datafile and re-enabled the purge job.',
      ],
      close: [
        'Solution provided',
        'Purge job disabled during a maintenance window was never re-enabled. Datafile added and purge job restored.',
      ],
      group: 'dba',
    }),
    (c) => ({
      short: `PostgreSQL replica lag over 10 minutes on ${c.pgDb}`,
      subcategory: 'Replication',
      alert: `pg_replication_lag_seconds > 600 on ${c.pgDb}-replica`,
      description: `Read replica for ${c.name} is more than 10 minutes behind the primary. Read-only screens show stale data.`,
      notes: [
        `Lag started during the nightly bulk load into ${c.tla} tables.`,
        'Load finished and the replica caught up. Throttling the load job.',
      ],
      close: [
        'Workaround provided',
        'Bulk load saturated WAL shipping. Replica caught up; load job throttled to 5k rows per commit.',
      ],
      group: 'dba',
    }),
    (c) => ({
      short: `Slow queries on ${c.db} after statistics job`,
      techCaller: true,
      subcategory: 'Performance',
      description: `${c.name} screens that search by customer take 20+ seconds since this morning.`,
      notes: [
        'Execution plan for the customer search query switched to a full table scan.',
        "Stale statistics after last night's partition maintenance. DBA regathered stats; plan back to an index range scan.",
      ],
      close: [
        'Solution provided',
        'Stale optimizer statistics after partition maintenance. Stats regathered and step added to the maintenance runbook.',
      ],
      group: 'dba',
    }),
    (c) => ({
      short: `Deadlocks in ${c.name} during ${c.job}`,
      subcategory: 'Locking',
      alert: `ORA-00060: deadlock detected while waiting for resource (${c.oracleDb})`,
      description: `Batch job ${c.job} and online ${c.tla} transactions are deadlocking on ${c.oracleDb}.`,
      notes: [
        `Deadlocks between ${c.job} and online updates to the same rows.`,
        `Moved ${c.job} after the online window as a workaround.`,
      ],
      close: [
        'Workaround provided',
        `${c.job} and online updates lock rows in opposite order. Job rescheduled; code fix tracked in the ${c.tla} backlog.`,
      ],
    }),
  ],
  access: [
    (c) => ({
      short: `Unable to log in to ${c.name} - account locked`,
      subcategory: 'Account lockout',
      description: `${c.callerFirst} cannot log in to ${c.name}; the screen says the account is locked after too many attempts.`,
      notes: [
        'Verified identity with the caller. Account locked in Active Directory after a password change on another device.',
        "Unlocked the account and removed the cached credential on the caller's phone.",
      ],
      close: [
        'Solution provided',
        'Lockout caused by an old password cached on a mobile device. Account unlocked; stale credential removed.',
      ],
      group: 'service_desk',
      branchCaller: true,
    }),
    (c) => ({
      short: `${c.name} - 403 Forbidden for ${c.dept} users after role change`,
      subcategory: 'Authorization',
      description: `${c.dept} users get "403 Forbidden" in ${c.name} since this morning. They had access yesterday.`,
      notes: [
        `The ${c.tla}_USER entitlement was removed for the department in last night's access certification.`,
        'Re-provisioned the entitlement through the identity governance tool.',
      ],
      hold: 'Waiting on the access certification owner to approve re-provisioning.',
      close: [
        'Solution provided',
        `Entitlement ${c.tla}_USER revoked in error during access certification. Re-provisioned for the affected users.`,
      ],
      group: 'iam',
    }),
    (c) => ({
      short: `MFA push not received when logging in to ${c.name}`,
      subcategory: 'MFA',
      description: `${c.callerFirst} does not receive the MFA push notification when logging in to ${c.name}.`,
      notes: [
        'Caller recently replaced their phone; the authenticator is still registered to the old device.',
        'Reset the MFA registration; caller enrolled the new device.',
      ],
      close: [
        'Solution provided',
        'Authenticator registered to an old device. MFA reset and new device enrolled.',
      ],
      group: 'service_desk',
    }),
    (c) => ({
      short: `Service account svc_${c.tlaLower}_app password expired`,
      subcategory: 'Service account',
      alert: `Authentication failures for svc_${c.tlaLower}_app on ${c.oracleDb}`,
      description: `${c.service} cannot authenticate to ${c.oracleDb}: ORA-28001 the password has expired.`,
      notes: [
        `${c.service} logs ORA-28001 on every connection attempt.`,
        `Rotated the password in the secrets vault and restarted ${c.service}.`,
      ],
      close: [
        'Solution provided',
        'Service account was not exempt from the 90-day password policy. Rotated and marked as a non-expiring service account.',
      ],
    }),
    (c) => ({
      short: `SSO redirect loop when opening ${c.name}`,
      subcategory: 'SSO',
      description: `Opening ${c.name} bounces between the login page and the app without loading.`,
      notes: [
        `Caller is stuck between the login page and ${c.name}. Other users at the same site are fine.`,
        'Cleared browser cookies for the SSO domain; caller can log in.',
      ],
      close: [
        'Resolved by caller',
        'Stale SSO session cookie in the browser. Cookies cleared; no server-side issue.',
      ],
      group: 'service_desk',
    }),
  ],
  hardware: [
    (c) => ({
      short: `Teller cash recycler offline at ${c.branch}`,
      subcategory: 'Cash recycler',
      description: `The cash recycler at ${c.branch} shows error E-201 and will not dispense. Tellers are using the vault.`,
      notes: [
        'Device shows error E-201 (note jam in the cassette).',
        'Vendor technician dispatched; ETA 2 hours.',
        'Technician cleared the jam and replaced the feed roller. Device balanced and back in service.',
      ],
      hold: 'Waiting on vendor technician dispatch.',
      close: [
        'Solution provided',
        'Note jam and worn feed roller. Vendor replaced the roller; recycler balanced and back in service.',
      ],
      branchCaller: true,
    }),
    (c) => ({
      short: `Receipt printer not printing at ${c.branch} teller station ${c.station}`,
      subcategory: 'Printer',
      description: `Teller station ${c.station} at ${c.branch} cannot print customer receipts.`,
      notes: [
        'Printer shows offline on the teller workstation. Power cycled with no change.',
        'Replaced the USB cable; printer back online and a test receipt printed.',
      ],
      close: ['Solution provided', 'Faulty USB cable on the teller receipt printer. Replaced.'],
      branchCaller: true,
    }),
    (c) =>
      c.app.supportGroupId === 'grp_atm_self_service_support'
        ? {
            short: `ATM ${c.atm} out of service - card reader fault`,
            subcategory: 'ATM',
            alert: `ATM ${c.atm} status OUT_OF_SERVICE (card reader fault)`,
            description: `ATM ${c.atm} at ${c.branch} reports a card reader fault and has taken itself out of service.`,
            notes: [
              'Device reports a card reader fault after a card capture.',
              'Vendor replaced the card reader; ATM back in service.',
            ],
            hold: 'Waiting on vendor parts.',
            close: [
              'Solution provided',
              'Card reader failed after a capture event. Vendor replaced the reader.',
            ],
          }
        : null,
    (c) => ({
      short: `Check scanner jamming at ${c.branch}`,
      subcategory: 'Scanner',
      description: `The teller check scanner at ${c.branch} jams on most deposits.`,
      notes: [
        'Scanner jams on every third item; the rollers are worn.',
        'Swapped the scanner with the branch spare and ordered a replacement.',
      ],
      close: [
        'Workaround provided',
        'Worn rollers on the check scanner. Swapped with spare; replacement on order.',
      ],
      branchCaller: true,
    }),
    (c) => ({
      short: `Branch workstation ${c.host} will not boot - ${c.branch}`,
      subcategory: 'Workstation',
      description: `Workstation ${c.host} at ${c.branch} stops at a disk error during boot.`,
      notes: [
        'Workstation stuck at the BIOS screen with a disk error.',
        'Desktop support replaced the SSD and re-imaged the workstation.',
      ],
      close: ['Solution provided', 'Failed SSD. Replaced and re-imaged.'],
      branchCaller: true,
    }),
  ],
  batch_job: [
    (c) => ({
      short: `${c.tla} nightly batch ${c.job} failed (RC=12)`,
      subcategory: 'Job failure',
      alert: `Control-M job ${c.job} ended NOTOK (RC=12)`,
      description: `Nightly job ${c.job} for ${c.name} failed. Downstream processing for the day is blocked.`,
      notes: [
        `Job failed reading its input file: file not found in /data/inbound/${c.tlaLower}.`,
        `Upstream transfer arrived 40 minutes late. Reran ${c.job}; completed successfully.`,
      ],
      close: [
        'Solution provided',
        "Input file arrived after the job's start time. Reran the job; added a file-watcher dependency.",
      ],
    }),
    (c) => ({
      short: `${c.job} for ${c.name} running past SLA`,
      subcategory: 'SLA breach',
      alert: `Control-M job ${c.job} late (SLA 05:00)`,
      description: `Batch job ${c.job} is still running past its 05:00 SLA.`,
      notes: [
        'Volume is 3x normal due to month-end.',
        'Increased parallelism to 8 threads; job completed at 05:42.',
      ],
      close: [
        'Workaround provided',
        'Month-end volume exceeded the batch window. Parallelism increased; capacity review requested.',
      ],
    }),
    (c) =>
      c.down
        ? {
            short: `${c.tla} EOD file not received by ${c.down.tla}`,
            techCaller: true,
            subcategory: 'File transfer',
            description: `${c.down.name} (${c.down.tla}) did not receive the end-of-day file from ${c.name}.`,
            notes: [
              `${c.job} completed but the Connect:Direct transfer to ${c.down.tla} failed with SVSJ032I.`,
              `Retransmitted the file; ${c.down.tla} confirmed receipt and reran their load.`,
            ],
            close: [
              'Solution provided',
              `Transfer to ${c.down.tla} failed because of an expired node certificate on the transfer server. Certificate renewed and file retransmitted.`,
            ],
          }
        : null,
    (c) => ({
      short: `${c.name} batch abended - duplicate key on load`,
      subcategory: 'Job failure',
      alert: `Job ${c.job} abended: ORA-00001 unique constraint violated`,
      description: `${c.job} abended while loading the daily file into ${c.oracleDb}.`,
      notes: [
        'Input contains duplicate records from a resent upstream file.',
        'Removed duplicates and restarted from the last checkpoint.',
      ],
      close: [
        'Solution provided',
        'Upstream resent a file, causing duplicate keys. Deduplicated and restarted from checkpoint.',
      ],
    }),
    (c) => ({
      short: `Control-M job ${c.job} stuck in Executing`,
      techCaller: true,
      subcategory: 'Scheduler',
      description: `${c.job} shows Executing for 3 hours with no progress in its log.`,
      notes: [
        'The Control-M agent on the batch host stopped reporting status.',
        'Restarted the Control-M agent; job status refreshed and the job completed.',
      ],
      close: ['Solution provided', 'Control-M agent hung after host patching. Agent restarted.'],
    }),
  ],
  performance: [
    (c) => ({
      short: `${c.name} response times degraded (p95 ${c.secs}s)`,
      subcategory: 'Latency',
      alert: `p95 latency ${c.secs}s on ${c.service} (threshold 1.5s)`,
      description: `${c.name} pages are slow. p95 latency on ${c.service} is ${c.secs}s.`,
      notes: [
        `GC pauses of 2-3 s on all ${c.service} pods since the traffic peak.`,
        'Increased heap from 2 GB to 4 GB and rolled the deployment. p95 back to 400 ms.',
      ],
      close: [
        'Solution provided',
        'Heap undersized for current volume, causing long GC pauses. Heap increased; capacity review scheduled.',
      ],
    }),
    (c) =>
      !c.branchApp
        ? null
        : {
            short: `Slowness reported in ${c.name} by branch staff`,
            subcategory: 'Branch',
            description: `Screens in ${c.name} take 10-15 seconds to load at ${c.branch}.`,
            notes: [
              `Server-side latency is normal; slowness is limited to ${c.branch}.`,
              'Branch bandwidth saturated by a patch rollout. Network throttled the distribution.',
            ],
            close: [
              'Solution provided',
              'Branch WAN saturated by patch distribution. Distribution moved outside business hours.',
            ],
            group: c.rng.chance(0.5) ? 'network' : 'app',
            branchCaller: true,
          },
    (c) => ({
      short: `High CPU on ${c.service} pods in ${c.cluster}`,
      subcategory: 'Capacity',
      alert: `CPU > 90% for 15m on ${c.service}`,
      description: `${c.service} pods are CPU bound and the HPA is at its maximum.`,
      notes: [
        'HPA already at max replicas (6).',
        'Raised max replicas to 12 and tuned the CPU request. Utilization back to 55%.',
      ],
      close: [
        'Workaround provided',
        'Traffic growth exceeded HPA limits. Max replicas raised; performance test scheduled.',
      ],
    }),
    (c) =>
      c.up
        ? {
            short: `${c.tla} API latency spike during peak hours`,
            subcategory: 'Latency',
            alert: `p95 latency ${c.secs}s on ${c.service} (threshold 1.5s)`,
            description: `${c.service} latency rises sharply between 11:00 and 13:00.`,
            notes: [
              `Latency correlates with slow responses from ${c.up.tla}.`,
              `Enabled response caching for ${c.up.tla} reference data calls. p95 back to normal.`,
            ],
            close: [
              'Workaround provided',
              `Repeated reference data calls to ${c.up.tla} during peak. Caching enabled.`,
            ],
          }
        : null,
    (c) => ({
      short: `Memory usage climbing on ${c.service} - possible leak`,
      subcategory: 'Memory',
      alert: `Memory > 85% on ${c.service} pods`,
      description: `Memory on ${c.service} grows steadily until pods are OOM killed roughly every 2 days.`,
      notes: [
        'Heap dump shows a growing session cache with no eviction.',
        'Scheduled a nightly rolling restart as a workaround; known error raised.',
      ],
      hold: `Waiting on the ${c.tla} dev team for a fix release date.`,
      close: [
        'Known error',
        'Unbounded session cache in the current release. Nightly rolling restart in place until the fix ships.',
      ],
    }),
  ],
};

const CATEGORY_WEIGHTS: [SeedCategory, number][] = [
  ['application', 30],
  ['performance', 14],
  ['access', 14],
  ['batch_job', 12],
  ['database', 10],
  ['network', 10],
  ['hardware', 10],
];

const HISTORY_PAIRS: [[ImpactUrgency, ImpactUrgency], number][] = [
  [[1, 1], 1.2],
  [[1, 2], 3],
  [[2, 1], 3],
  [[2, 2], 12],
  [[1, 3], 5],
  [[3, 1], 5],
  [[2, 3], 22],
  [[3, 2], 22],
  [[3, 3], 18],
];

const OPEN_PAIRS: [[ImpactUrgency, ImpactUrgency], number][] = [
  [[2, 2], 3],
  [[1, 3], 1],
  [[3, 1], 1],
  [[2, 3], 4],
  [[3, 2], 4],
  [[3, 3], 3],
];

/** Minutes from open to resolution by priority. */
const DURATION: Record<number, [number, number]> = {
  1: [60, 240],
  2: [120, 600],
  3: [180, 2880],
  4: [360, 7200],
  5: [720, 14400],
};

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const AUTO_CLOSE_DAYS = 3;

interface Draft {
  rec: IncidentRecord;
  /** Canceled duplicates point at an earlier incident once numbers are known. */
  duplicateNote?: JournalRecord;
}

export function seedIncidents(dir: Directory, now: Date, ids: IdGen): IncidentRecord[] {
  const rng = new Rng('servicenow-incidents');
  const world = dir.world;
  const nowMs = now.getTime();

  const people = world.people;
  const branchPeople = people.filter((p) => p.role === 'branch');
  const officePeople = people.filter((p) =>
    ['engineer', 'support', 'manager', 'service_desk'].includes(p.role),
  );
  const serviceDesk = world.groupsById.get(SHARED_GROUP_IDS.serviceDesk)!.memberUsernames;
  const mim = world.groupsById.get(SHARED_GROUP_IDS.majorIncident)!.memberUsernames;
  const heroApps = world.apps.filter((a) => a.hero);
  const branchApps = world.apps.filter(
    (a) =>
      a.tla === 'TLR' ||
      a.supportGroupId === 'grp_branch_technology_support' ||
      a.supportGroupId === 'grp_atm_self_service_support',
  );
  const batchApps = world.apps.filter((a) => a.repoPaths.some((p) => p.endsWith('-batch')));
  const accessApps = world.apps.filter((a) => ['OLB', 'MBL', 'ATH', 'TLR', 'CRD'].includes(a.tla));
  const iamGroup = dir.findGroup('grp_identity_access_support')?.id;

  // Open incidents stay off the hero apps so they don't muddy scenario demos.
  const pickApp = (category: SeedCategory, open: boolean): App => {
    const pool = (apps: App[]) => (open ? apps.filter((a) => !a.hero) : apps);
    switch (category) {
      case 'hardware':
        return rng.pick(pool(branchApps));
      case 'batch_job':
        return rng.chance(0.85) || open ? rng.pick(pool(batchApps)) : rng.pick(heroApps);
      case 'access':
        return rng.chance(0.5) && !open ? rng.pick(accessApps) : rng.pick(pool(world.apps));
      case 'network':
        return rng.chance(0.4) ? rng.pick(pool(branchApps)) : rng.pick(pool(world.apps));
      default:
        return rng.chance(0.4) && !open ? rng.pick(heroApps) : rng.pick(pool(world.apps));
    }
  };

  const pickBranchCaller = (): Person => {
    if (rng.chance(0.15)) {
      return world.peopleByUsername.get(rng.pick([PERSONAS.branchManager, PERSONAS.headTeller]))!;
    }
    return rng.pick(branchPeople);
  };

  const groupFor = (hint: GroupHint | undefined, app: App): string => {
    switch (hint) {
      case 'network':
        return SHARED_GROUP_IDS.network;
      case 'dba':
        return SHARED_GROUP_IDS.dba;
      case 'cloud':
        return SHARED_GROUP_IDS.cloud;
      case 'service_desk':
        return SHARED_GROUP_IDS.serviceDesk;
      case 'iam':
        return iamGroup ?? app.supportGroupId;
      default:
        return app.supportGroupId;
    }
  };

  const pickMember = (groupId: string, exclude?: string): string => {
    const group = world.groupsById.get(groupId)!;
    const preferred = group.memberUsernames.filter((u) => {
      const p = world.peopleByUsername.get(u);
      return u !== exclude && p && ['support', 'infra', 'noc', 'service_desk'].includes(p.role);
    });
    return rng.pick(preferred.length > 0 ? preferred : group.memberUsernames);
  };

  // Which of the 200 incidents are still open.
  const openSlots = new Map<number, IncidentState>();
  rng
    .pickN(
      Array.from({ length: TOTAL }, (_, i) => i),
      OPEN_STATES.length,
    )
    .forEach((index, i) => {
      openSlots.set(index, OPEN_STATES[i]!);
    });

  const drafts: Draft[] = [];
  const usedOpenStories = new Set<string>();
  for (let i = 0; i < TOTAL; i++) {
    const openState = openSlots.get(i);
    const category = rng.weighted(CATEGORY_WEIGHTS);
    const app = pickApp(category, openState !== undefined);
    const branchPerson = pickBranchCaller();
    const ctx: Ctx = {
      rng,
      app,
      tla: app.tla,
      tlaLower: app.tla.toLowerCase(),
      name: app.name,
      service: app.runtime.service,
      ns: app.runtime.namespace,
      cluster: app.runtime.cluster,
      up: app.upstream.length ? world.appsByTla.get(rng.pick(app.upstream)) : undefined,
      down: app.downstream.length ? world.appsByTla.get(rng.pick(app.downstream)) : undefined,
      branch: branchPerson.location,
      callerFirst: branchPerson.firstName,
      feature: rng.pick(FEATURES),
      job: `${app.tla}${rng.pick(['DLY', 'EOD', 'NGT', 'MTH'])}${rng.int(1, 9)}${rng.int(0, 9)}0`,
      db: app.stack === 'java-spring' ? `${app.tla}PRD` : `pg-${app.tla.toLowerCase()}-prod-01`,
      oracleDb: `${app.tla}PRD`,
      pgDb: `pg-${app.tla.toLowerCase()}-prod-01`,
      version: `${rng.int(1, 4)}.${rng.int(0, 30)}.${rng.int(0, 9)}`,
      pct: rng.int(8, 46),
      prop: rng.pick(PROPS[app.stack] ?? PROPS['java-spring']!),
      exception: rng.pick(EXCEPTIONS[app.stack] ?? EXCEPTIONS['java-spring']!),
      host: `KBW${rng.int(10000, 99999)}`,
      ip: `10.${rng.int(20, 40)}.${rng.int(0, 255)}.${rng.int(2, 250)}`,
      vendor: rng.pick(VENDORS),
      dept: rng.pick([
        'Branch Banking',
        'Commercial Banking',
        'Contact Center',
        'Wealth Management',
      ]),
      change: `CHG00${rng.int(31000, 39999)}`,
      atm: `KB${rng.int(1000, 9999)}`,
      secs: rng.float(2.1, 6.8).toFixed(1),
      station: rng.int(1, 6),
      branchApp: branchApps.includes(app),
    };
    // Start at a random template and take the first that fits this app. Open incidents avoid
    // repeating a template another open incident already uses.
    const fns = STORIES[category];
    const start = rng.int(0, fns.length - 1);
    let story: Story | null = null;
    for (const pass of [0, 1]) {
      for (let k = 0; k < fns.length && !story; k++) {
        const index = (start + k) % fns.length;
        if (pass === 0 && openState && usedOpenStories.has(`${category}:${index}`)) continue;
        story = fns[index]!(ctx);
        if (story && openState) usedOpenStories.add(`${category}:${index}`);
      }
      if (story) break;
    }
    if (!story) throw new Error(`No incident story fits ${app.tla} (${category})`);

    // Who reported it.
    const contact: ContactType = story.alert
      ? rng.chance(0.85)
        ? 'monitoring'
        : 'email'
      : rng.weighted<ContactType>([
          ['phone', 55],
          ['email', 25],
          ['self_service', 20],
        ]);
    let caller: string;
    let openedBy: string;
    if (contact === 'monitoring') {
      caller = PERSONAS.incidentBot;
      openedBy = PERSONAS.incidentBot;
    } else {
      // Branch associates report what they see at the branch; technical symptoms come from IT.
      const fromBranch =
        story.branchCaller ||
        category === 'hardware' ||
        (!story.alert && !story.techCaller && rng.chance(0.4));
      const person = fromBranch ? branchPerson : rng.pick(officePeople);
      caller = person.username;
      openedBy = contact === 'self_service' ? person.username : rng.pick(serviceDesk);
    }

    // Major incidents (P1/P2) only happen on tier 1 apps (P2 also on tier 2).
    const pairs = (openState ? OPEN_PAIRS : HISTORY_PAIRS).filter(
      ([[i, u]]) => priorityFor(i, u) >= (app.tier === 1 ? 1 : app.tier === 2 ? 2 : 3),
    );
    const [impact, urgency] = rng.weighted(pairs);
    const priority = priorityFor(impact, urgency);
    const group = groupFor(story.group, app);

    // Timeline.
    const openedMs = openState
      ? nowMs - rng.int(90, 6 * 24 * 60) * MIN
      : nowMs - rng.int(Math.round(1.2 * 24 * 60), 90 * 24 * 60) * MIN;
    const [dMin, dMax] = DURATION[priority]!;
    const latestResolve = nowMs - 20 * MIN;
    const resolveMs = Math.min(openedMs + rng.int(dMin, dMax) * MIN, latestResolve);
    const canceled = !openState && rng.chance(0.04);

    let state: IncidentState;
    if (openState) state = openState;
    else if (canceled) state = 'canceled';
    else if (resolveMs + AUTO_CLOSE_DAYS * DAY < nowMs) state = 'closed';
    else state = 'resolved';

    const iso = (ms: number) => new Date(ms).toISOString();
    const assignee = state === 'new' || state === 'canceled' ? null : pickMember(group);
    const callerPerson = world.peopleByUsername.get(caller)!;
    const human = contact !== 'monitoring';

    const description = human
      ? `Reported by ${callerPerson.name} (${callerPerson.title}, ${callerPerson.location}) via ${CONTACT_TYPE_LABELS[contact].toLowerCase()}. Callback: ${callerPerson.phone}.\n\n${story.description}`
      : `${story.alert}\n\n${story.description}\n\nApplication: ${app.name} (${app.tla}). Service: ${app.runtime.service}, namespace ${app.runtime.namespace}, cluster ${app.runtime.cluster}.`;

    const rec: IncidentRecord = {
      sys_id: '',
      number: '',
      short_description: story.short,
      description,
      state,
      impact,
      urgency,
      category,
      subcategory: story.subcategory,
      app_tla: app.tla,
      caller,
      opened_by: openedBy,
      contact_type: contact,
      assignment_group: state === 'new' && rng.chance(0.25) ? null : group,
      assigned_to: assignee,
      opened_at: iso(openedMs),
      updated_at: iso(openedMs),
      updated_by: openedBy,
      resolved_at: null,
      resolved_by: null,
      closed_at: null,
      close_code: null,
      close_notes: null,
      reassignment_count: 0,
      reopen_count: 0,
      parent_incident: null,
      ...emptyResolution(),
      links: [],
      journal: [],
    };

    // ----- Journal -----
    const journal = rec.journal;
    const add = (
      type: JournalRecord['type'],
      text: string,
      author: string,
      ms: number,
      changes?: FieldChange[],
    ) => {
      const entry: JournalRecord = { id: ids.journal(), type, text, author, created_at: iso(ms) };
      if (changes) entry.changes = changes;
      journal.push(entry);
      return entry;
    };
    const change = (field: string, label: string, from: string | null, to: string | null) => ({
      field,
      label,
      from,
      to,
    });

    const opening: FieldChange[] = [
      change('state', 'State', null, STATE_LABELS.new),
      change('priority', 'Priority', null, PRIORITY_LABELS[priority]),
      change('impact', 'Impact', null, IMPACT_LABELS[impact]),
      change('urgency', 'Urgency', null, IMPACT_LABELS[urgency]),
      change('app_tla', 'Configuration item', null, dir.appDisplay(app.tla)),
    ];
    if (rec.assignment_group) {
      opening.push(
        change(
          'assignment_group',
          'Assignment group',
          null,
          dir.groupRef(rec.assignment_group).name,
        ),
      );
    }
    add(
      'system',
      `Incident opened via ${CONTACT_TYPE_LABELS[contact]}`,
      openedBy,
      openedMs,
      opening,
    );

    if (!human) {
      add(
        'work_note',
        `Auto-created from monitoring alert: ${story.alert}\nSource: ${app.runtime.service} (${app.runtime.cluster}/${app.runtime.namespace})`,
        PERSONAS.incidentBot,
        openedMs,
      );
      if (app.emitsLogs && rng.chance(0.6)) {
        const query = `labels.app_tla="${app.tla}" AND severity>=ERROR`;
        rec.links.push({
          id: ids.link(),
          type: 'log_query',
          url: `${URLS.logs.web}/logs?query=${encodeURIComponent(query)}`,
          title: `${app.tla} error logs`,
          added_by: PERSONAS.incidentBot,
          added_at: iso(openedMs),
        });
      }
    } else if (openedBy !== caller) {
      add(
        'work_note',
        `${contact === 'phone' ? 'Took the call from' : 'Received the email from'} ${callerPerson.name}. Basic checks done; routing to ${dir.groupRef(group).name}.`,
        openedBy,
        openedMs + rng.int(2, 8) * MIN,
      );
    }

    let duplicateNote: JournalRecord | undefined;
    if (state === 'canceled') {
      const at = openedMs + rng.int(15, 90) * MIN;
      add('system', 'State changed from New to Canceled', openedBy, at, [
        change('state', 'State', STATE_LABELS.new, STATE_LABELS.canceled),
      ]);
      duplicateNote = add('work_note', '', openedBy, at);
      rec.close_code = 'Duplicate';
      rec.close_notes = 'Duplicate incident';
    } else if (assignee) {
      const fast = priority <= 2;
      const endMs = state === 'in_progress' || state === 'on_hold' ? nowMs - 5 * MIN : resolveMs;
      const assignMs = Math.min(
        openedMs + rng.int(fast ? 2 : 5, fast ? 10 : 45) * MIN,
        endMs - 4 * MIN,
      );
      const assigneeName = dir.userRef(assignee).name;
      add(
        'system',
        `State changed from New to In Progress\nAssigned to changed from (empty) to ${assigneeName}`,
        assignee,
        assignMs,
        [
          change('state', 'State', STATE_LABELS.new, STATE_LABELS.in_progress),
          change('assigned_to', 'Assigned to', null, assigneeName),
        ],
      );
      if (human) {
        add(
          'comment',
          `Hi ${callerPerson.firstName}, I've picked this up and am looking into it now. I'll post updates here.`,
          assignee,
          assignMs + MIN,
        );
      }
      if (fast && !openState) {
        add(
          'work_note',
          `Major incident declared. Bridge opened with ${dir.groupRef(group).name} and the NOC; updates every 30 minutes.`,
          rng.pick(mim),
          assignMs + 2 * MIN,
        );
      }

      // Work notes: all of them for finished incidents, the investigation so far for open ones.
      let notes = story.notes;
      if (state === 'in_progress') notes = notes.slice(0, Math.max(1, notes.length - 1));
      if (state === 'on_hold') notes = notes.slice(0, 1);
      const span = Math.max(endMs - assignMs - 3 * MIN, notes.length * MIN);
      notes.forEach((text, n) => {
        const at = assignMs + 3 * MIN + Math.round((span * (n + 1)) / (notes.length + 1));
        add('work_note', text, rng.chance(0.85) ? assignee : pickMember(group, assignee), at);
      });

      if (state === 'on_hold') {
        const at = Math.min(endMs, assignMs + 3 * MIN + span);
        add(
          'work_note',
          story.hold ??
            (human
              ? 'Waiting on the caller to confirm a time to test.'
              : 'Waiting on a change window to apply the permanent fix.'),
          assignee,
          at,
        );
        add('system', 'State changed from In Progress to On Hold', assignee, at, [
          change('state', 'State', STATE_LABELS.in_progress, STATE_LABELS.on_hold),
        ]);
      }

      if (state === 'resolved' || state === 'closed') {
        const [code, notesText] = story.close;
        rec.close_code = code;
        rec.close_notes = notesText;
        rec.resolved_at = iso(resolveMs);
        rec.resolved_by = assignee;
        add(
          'system',
          `State changed from In Progress to Resolved\nResolution code changed from (empty) to ${code}`,
          assignee,
          resolveMs,
          [
            change('state', 'State', STATE_LABELS.in_progress, STATE_LABELS.resolved),
            change('close_code', 'Resolution code', null, code),
          ],
        );
        if (human) {
          add(
            'comment',
            `Hi ${callerPerson.firstName}, this is resolved. ${notesText.split('. ')[0]!.replace(/\.$/, '')}. Reply here if you still see the problem.`,
            assignee,
            resolveMs,
          );
        }
        if (fast) {
          add(
            'work_note',
            'Post-incident review scheduled with the application team and Major Incident Management.',
            rng.pick(mim),
            resolveMs + rng.int(10, 60) * MIN,
          );
        }
      }
      if (state === 'closed') {
        const closeMs = resolveMs + AUTO_CLOSE_DAYS * DAY;
        rec.closed_at = iso(closeMs);
        add('system', 'State changed from Resolved to Closed', SYSTEM_USER, closeMs, [
          change('state', 'State', STATE_LABELS.resolved, STATE_LABELS.closed),
        ]);
      }
    }

    journal.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const last = journal[journal.length - 1]!;
    rec.updated_at = last.created_at;
    rec.updated_by = last.author;
    drafts.push({ rec, duplicateNote });
  }

  // Number in opened order, skipping the numbers the past major incidents own (they were picked
  // to fall in opened order too).
  const reserved = new Set(PAST_MAJOR_INCIDENTS.map((p) => p.number));
  drafts.sort((a, b) => a.rec.opened_at.localeCompare(b.rec.opened_at));
  let next = FIRST_NUMBER;
  for (const d of drafts) {
    while (reserved.has(incidentNumber(next))) next++;
    d.rec.number = incidentNumber(next++);
    d.rec.sys_id = sysId(`incident:${d.rec.number}`);
  }
  for (const inc of PAST_MAJOR_INCIDENTS)
    drafts.push({ rec: pastMajorIncident(dir, inc, now, ids) });
  drafts.sort((a, b) => a.rec.number.localeCompare(b.rec.number));
  drafts.forEach((d, i) => {
    if (!d.duplicateNote) return;
    const original = drafts
      .slice(0, i)
      .reverse()
      .find((o) => o.rec.app_tla === d.rec.app_tla && o.rec.state !== 'canceled');
    if (original) {
      d.duplicateNote.text = `Duplicate of ${original.rec.number}; tracking there.`;
      d.rec.close_notes = `Duplicate of ${original.rec.number}.`;
    } else {
      d.duplicateNote.text = 'Caller confirmed this was raised in error. Canceling.';
      d.rec.close_code = 'No resolution provided';
      d.rec.close_notes = 'Raised in error.';
    }
  });
  return drafts.map((d) => d.rec);
}

/**
 * A past major incident shared with Teams: opened by monitoring, worked by the app's on-call
 * primary, resolved.
 */
function pastMajorIncident(
  dir: Directory,
  inc: PastMajorIncident,
  now: Date,
  ids: IdGen,
): IncidentRecord {
  const world = dir.world;
  const app = world.appsByTla.get(inc.tla)!;
  const group = world.groupsById.get(app.supportGroupId)!;
  const oncall = group.onCall.primary;
  const dev = app.developerUsernames[0]!;
  const bot = PERSONAS.incidentBot;
  const mim = PERSONAS.majorIncidentManager;
  const major = inc.priority !== 'P3';
  const priority = priorityFor(inc.impact, inc.urgency);
  const { service, namespace, cluster } = app.runtime;
  const extra = inc.extraTla ? world.appsByTla.get(inc.extraTla)! : undefined;
  const extraGroup = extra ? world.groupsById.get(extra.supportGroupId)! : undefined;

  const openedMs = now.getTime() - inc.hoursAgo * 60 * MIN;
  const resolveMs = openedMs + inc.durationMin * MIN;
  const closeMs = resolveMs + AUTO_CLOSE_DAYS * DAY;
  const closed = closeMs < now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const at = (min: number) => iso(openedMs + min * MIN);
  const name = (u: string) => dir.userRef(u).name;

  const journal: JournalRecord[] = [];
  const add = (type: JournalRecord['type'], min: number, author: string, text: string) => {
    const entry: JournalRecord = { id: ids.journal(), type, text, author, created_at: at(min) };
    journal.push(entry);
    return entry;
  };
  const change = (field: string, label: string, from: string | null, to: string | null) => ({
    field,
    label,
    from,
    to,
  });

  add('system', 0, bot, 'Incident opened via Monitoring').changes = [
    change('state', 'State', null, STATE_LABELS.new),
    change('priority', 'Priority', null, PRIORITY_LABELS[priority]),
    change('impact', 'Impact', null, IMPACT_LABELS[inc.impact]),
    change('urgency', 'Urgency', null, IMPACT_LABELS[inc.urgency]),
    change('app_tla', 'Configuration item', null, dir.appDisplay(app.tla)),
    change('assignment_group', 'Assignment group', null, group.name),
  ];
  add(
    'work_note',
    0,
    bot,
    `Auto-created from monitoring alert: ${inc.alert}\nSource: ${service} (${cluster}/${namespace})`,
  );
  const added = [
    `${name(PERSONAS.nocLead)} (NOC shift lead, incident commander)`,
    ...(major ? [`${name(mim)} (major incident manager)`] : []),
    `${name(oncall)} (${app.tla} on-call primary)`,
    `${name(dev)} (${app.tla} developer)`,
    ...(extraGroup ? [`${name(extraGroup.onCall.primary)} (${extra!.tla} on-call primary)`] : []),
  ];
  add('work_note', 1, bot, `Engaged ${added.join(', ')}.`);
  add(
    'system',
    4,
    oncall,
    `State changed from New to In Progress\nAssigned to changed from (empty) to ${name(oncall)}`,
  ).changes = [
    change('state', 'State', STATE_LABELS.new, STATE_LABELS.in_progress),
    change('assigned_to', 'Assigned to', null, name(oncall)),
  ];
  if (major) {
    add(
      'work_note',
      6,
      mim,
      `Major incident declared. Bridge opened with ${group.name} and the NOC; updates every 30 minutes.`,
    );
  }
  if (extra && extraGroup) {
    add(
      'work_note',
      10,
      oncall,
      `Engaged ${extraGroup.name} (${name(extraGroup.onCall.primary)}): ${extra.tla} - ${extra.name} is an upstream dependency of ${service}.`,
    );
  }
  add(
    'work_note',
    18,
    dev,
    `Root cause found: ${inc.cause[0]!.toUpperCase()}${inc.cause.slice(1)}`,
  );
  add('work_note', 26, oncall, `Applying the fix: ${inc.action}.`);
  add(
    'work_note',
    inc.durationMin - 10,
    dev,
    'Error rate is back to baseline. Monitoring for 10 minutes before resolving.',
  );
  add(
    'system',
    inc.durationMin,
    oncall,
    `State changed from In Progress to Resolved\nResolution code changed from (empty) to ${inc.closeCode}`,
  ).changes = [
    change('state', 'State', STATE_LABELS.in_progress, STATE_LABELS.resolved),
    change('close_code', 'Resolution code', null, inc.closeCode),
  ];
  if (major) {
    add(
      'work_note',
      inc.durationMin + 4,
      mim,
      `Post-incident review scheduled for Thursday with ${group.name} and Major Incident Management. ${name(dev)} to bring the timeline.`,
    );
  }
  if (closed) {
    const closeMin = inc.durationMin + AUTO_CLOSE_DAYS * 24 * 60;
    add('system', closeMin, SYSTEM_USER, 'State changed from Resolved to Closed').changes = [
      change('state', 'State', STATE_LABELS.resolved, STATE_LABELS.closed),
    ];
  }
  journal.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = journal[journal.length - 1]!;

  const logQuery = `resource.labels.container_name="${service}" AND severity>=ERROR`;
  return {
    sys_id: sysId(`incident:${inc.number}`),
    number: inc.number,
    short_description: inc.shortDescription,
    description: `${inc.alert}\n\n${inc.summary}\n\nApplication: ${app.name} (${app.tla}). Service: ${service}, namespace ${namespace}, cluster ${cluster}.`,
    state: closed ? 'closed' : 'resolved',
    impact: inc.impact,
    urgency: inc.urgency,
    category: inc.category,
    subcategory: inc.subcategory,
    app_tla: app.tla,
    caller: bot,
    opened_by: bot,
    contact_type: 'monitoring',
    assignment_group: group.id,
    assigned_to: oncall,
    opened_at: iso(openedMs),
    updated_at: last.created_at,
    updated_by: last.author,
    resolved_at: iso(resolveMs),
    resolved_by: oncall,
    closed_at: closed ? iso(closeMs) : null,
    close_code: inc.closeCode,
    close_notes: inc.closeNotes,
    reassignment_count: 0,
    reopen_count: 0,
    parent_incident: null,
    ...emptyResolution(),
    links: [
      {
        id: ids.link(),
        type: 'log_query',
        url: `${URLS.logs.web}/logs?query=${encodeURIComponent(logQuery)}`,
        title: `${service} errors`,
        added_by: bot,
        added_at: at(1),
      },
    ],
    journal,
  };
}
