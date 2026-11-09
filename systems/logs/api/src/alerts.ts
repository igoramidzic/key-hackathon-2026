import { notFound } from '@sim/api-kit';
import type {
  Alert,
  AlertInput,
  AlertManager,
  AlertSeverity,
  AlertStatus,
  AlertUpdate,
} from '@sim/contracts/logs';
import { alertWebUrl } from '@sim/contracts/logs';
import { type App, getGroup, getWorld, Rng } from '@sim/world';

export const FIRST_ALERT_ID = 48201;

export interface AlertFilter {
  status?: string[];
  severity?: string[];
  app_tla?: string[];
  service?: string[];
  q?: string;
  since?: Date;
}

/** Moogsoft-style alert store. Repeat events with an open dedupe_key bump the existing alert. */
export class AlertStore {
  private alerts = new Map<number, Alert>();
  private nextId = FIRST_ALERT_ID;

  constructor() {
    this.reset();
  }

  reset(now = new Date()) {
    this.alerts.clear();
    this.nextId = FIRST_ALERT_ID;
    for (const seed of seedAlerts(now)) {
      const id = this.nextId++;
      this.alerts.set(id, ordered({ ...seed, id, web_url: alertWebUrl(id) }));
    }
  }

  get openCount() {
    let n = 0;
    for (const a of this.alerts.values())
      if (a.status === 'open' || a.status === 'acknowledged') n++;
    return n;
  }

  get total() {
    return this.alerts.size;
  }

  get(id: number): Alert {
    const alert = this.alerts.get(id);
    if (!alert) throw notFound(`Alert ${id} not found`);
    return alert;
  }

  /** Creates an alert, or bumps the open/acknowledged one with the same dedupe_key. */
  raise(input: AlertInput, now = new Date()): { alert: Alert; created: boolean } {
    const at = input.event_time ?? now.toISOString();
    const existing = [...this.alerts.values()].find(
      (a) =>
        a.dedupe_key === input.dedupe_key && (a.status === 'open' || a.status === 'acknowledged'),
    );
    if (existing) {
      existing.event_count++;
      if (at > existing.last_event_time) existing.last_event_time = at;
      existing.description = input.description;
      existing.custom_info = { ...existing.custom_info, ...input.custom_info };
      if (input.severity === 'clear') {
        existing.severity = 'clear';
        existing.status = 'resolved';
        existing.notes.push({
          at,
          author: input.manager,
          text: `Clear event received from ${input.manager}; alert resolved.`,
        });
      } else {
        existing.severity = input.severity;
      }
      return { alert: existing, created: false };
    }
    const id = this.nextId++;
    const alert: Alert = {
      id,
      severity: input.severity,
      status: input.severity === 'clear' ? 'resolved' : 'open',
      description: input.description,
      source: input.source,
      service: input.service,
      app_tla: input.app_tla.toUpperCase(),
      manager: input.manager,
      class: input.class,
      check: input.check,
      dedupe_key: input.dedupe_key,
      first_event_time: at,
      last_event_time: at,
      event_count: 1,
      owner: null,
      incident_number: null,
      notes: [],
      custom_info: { ...input.custom_info },
      web_url: alertWebUrl(id),
    };
    this.alerts.set(id, alert);
    return { alert, created: true };
  }

  update(id: number, patch: AlertUpdate, now = new Date()): Alert {
    const alert = this.get(id);
    if (patch.status !== undefined) alert.status = patch.status;
    if (patch.severity !== undefined) alert.severity = patch.severity;
    if (patch.owner !== undefined) alert.owner = patch.owner;
    if (patch.incident_number !== undefined) alert.incident_number = patch.incident_number;
    if (patch.note) {
      alert.notes.push({ at: now.toISOString(), author: patch.note.author, text: patch.note.text });
    }
    return alert;
  }

  list(filter: AlertFilter): Alert[] {
    const q = filter.q?.trim().toLowerCase();
    const sinceIso = filter.since?.toISOString();
    const status = filter.status && new Set(filter.status.map((s) => s.toLowerCase()));
    const severity = filter.severity && new Set(filter.severity.map((s) => s.toLowerCase()));
    const tla = filter.app_tla && new Set(filter.app_tla.map((s) => s.toUpperCase()));
    const service = filter.service && new Set(filter.service.map((s) => s.toLowerCase()));
    return [...this.alerts.values()]
      .filter((a) => {
        if (status && !status.has(a.status)) return false;
        if (severity && !severity.has(a.severity)) return false;
        if (tla && !tla.has(a.app_tla)) return false;
        if (service && !service.has(a.service.toLowerCase())) return false;
        if (sinceIso && a.last_event_time < sinceIso) return false;
        if (q) {
          const hay = [
            String(a.id),
            a.description,
            a.source,
            a.service,
            a.check,
            a.app_tla,
            a.owner ?? '',
            a.incident_number ?? '',
          ]
            .join('\n')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.last_event_time.localeCompare(a.last_event_time) || b.id - a.id);
  }
}

/** Same key order as alerts created via the API (id first), for readable JSON. */
function ordered(a: Alert): Alert {
  return {
    id: a.id,
    severity: a.severity,
    status: a.status,
    description: a.description,
    source: a.source,
    service: a.service,
    app_tla: a.app_tla,
    manager: a.manager,
    class: a.class,
    check: a.check,
    dedupe_key: a.dedupe_key,
    first_event_time: a.first_event_time,
    last_event_time: a.last_event_time,
    event_count: a.event_count,
    owner: a.owner,
    incident_number: a.incident_number,
    notes: a.notes,
    custom_info: a.custom_info,
    web_url: a.web_url,
  };
}

// ---------------------------------------------------------------------------
// Deterministic background alerts (non-hero apps), relative to reset time
// ---------------------------------------------------------------------------

type SeedAlert = Omit<Alert, 'id' | 'web_url'>;

interface Template {
  severity: AlertSeverity;
  manager: AlertManager;
  class: string;
  check: string;
  source: (app: App, rng: Rng) => string;
  describe: (app: App, rng: Rng) => { description: string; info: Alert['custom_info'] };
  resolution: string;
}

const pod = (app: App, rng: Rng) => `${app.runtime.service}-${rng.hex(9)}-${rng.alnum(5)}`;
const node = (app: App, rng: Rng) => `${app.runtime.cluster}-pool-${rng.int(1, 4)}-${rng.hex(8)}`;
const host = (app: App) => `${app.runtime.service}.${app.runtime.namespace}.keybank.example`;

const TEMPLATES: Template[] = [
  {
    severity: 'major',
    manager: 'SolarWinds',
    class: 'Infrastructure',
    check: 'disk_usage_pct',
    source: node,
    describe: (_app, rng) => {
      const value = rng.int(91, 97);
      return {
        description: `Disk usage ${value}% on /var/lib/containerd (threshold 90%)`,
        info: { mount: '/var/lib/containerd', value, threshold: 90 },
      };
    },
    resolution: 'Pruned unused container images; usage back to 61%.',
  },
  {
    severity: 'major',
    manager: 'AppDynamics',
    class: 'Application',
    check: 'http_5xx_rate',
    source: pod,
    describe: (app, rng) => {
      const value = rng.float(5.5, 9.5).toFixed(1);
      return {
        description: `HTTP 5xx rate ${value}% on ${app.runtime.service} (threshold 5%)`,
        info: { value: Number(value), threshold: 5, window: '5m' },
      };
    },
    resolution: 'Transient upstream timeouts during a node pool upgrade. Rate normal since.',
  },
  {
    severity: 'minor',
    manager: 'AppDynamics',
    class: 'Application',
    check: 'latency_p95',
    source: pod,
    describe: (app, rng) => {
      const value = rng.float(1.6, 2.9).toFixed(2);
      return {
        description: `Response time p95 ${value}s on ${app.runtime.service} (threshold 1.5s)`,
        info: { value_s: Number(value), threshold_s: 1.5 },
      };
    },
    resolution: 'Latency recovered after the nightly batch finished. No customer impact.',
  },
  {
    severity: 'critical',
    manager: 'GCP Monitoring',
    class: 'Application',
    check: 'k8s_container_restarts',
    source: pod,
    describe: (app, rng) => {
      const value = rng.int(5, 9);
      return {
        description: `Container ${app.runtime.service} restarted ${value} times in 10m (CrashLoopBackOff)`,
        info: { restarts: value, window: '10m', reason: 'OOMKilled' },
      };
    },
    resolution: 'Raised memory limit from 1Gi to 1.5Gi; pods stable.',
  },
  {
    severity: 'major',
    manager: 'Synthetics',
    class: 'Synthetic',
    check: 'synthetic_journey',
    source: () => 'synthetics-us-east4',
    describe: (app) => ({
      description: `Synthetic check failed 3/3 locations: ${app.name} health journey`,
      info: { locations_failed: 3, locations_total: 3, step: 'GET /actuator/health' },
    }),
    resolution: 'Failed during planned maintenance window; check passing again.',
  },
  {
    severity: 'minor',
    manager: 'AppDynamics',
    class: 'Application',
    check: 'jvm_heap_pct',
    source: pod,
    describe: (app, rng) => {
      const value = rng.int(88, 95);
      return {
        description: `JVM heap usage ${value}% on ${app.runtime.service} (threshold 85%)`,
        info: { value, threshold: 85, gc_pause_ms: rng.int(300, 900) },
      };
    },
    resolution: 'Heap settled after a full GC; tracking a leak fix in the next release.',
  },
  {
    severity: 'warning',
    manager: 'Splunk',
    class: 'Application',
    check: 'batch_sla',
    source: (app) => `${app.runtime.service}-nightly`,
    describe: (app, rng) => {
      const value = rng.int(18, 55);
      return {
        description: `Batch job ${app.runtime.service}-nightly exceeded SLA by ${value}m`,
        info: { overrun_min: value, sla: '02:00 ET' },
      };
    },
    resolution: 'Job completed late due to upstream file delay; downstream consumers notified.',
  },
  {
    severity: 'major',
    manager: 'AppDynamics',
    class: 'Application',
    check: 'db_pool_saturation',
    source: pod,
    describe: (app, rng) => {
      const max = rng.pick([20, 30, 50]);
      return {
        description: `DB connection pool saturated on ${app.runtime.service} (active ${max}/${max})`,
        info: { active: max, max, waiting: rng.int(5, 40) },
      };
    },
    resolution: 'Long-running report query killed by DBA; pool drained.',
  },
  {
    severity: 'minor',
    manager: 'Prometheus',
    class: 'Middleware',
    check: 'kafka_consumer_lag',
    source: pod,
    describe: (app, rng) => {
      const value = rng.int(8, 40) * 1000;
      return {
        description: `Kafka consumer lag ${value.toLocaleString('en-US')} on ${app.runtime.namespace}.events (threshold 5,000)`,
        info: { lag: value, threshold: 5000, topic: `${app.runtime.namespace}.events` },
      };
    },
    resolution: 'Consumer group scaled to 6 replicas; lag cleared.',
  },
  {
    severity: 'major',
    manager: 'GCP Monitoring',
    class: 'Application',
    check: 'log_error_rate',
    source: pod,
    describe: (app, rng) => {
      const value = rng.int(180, 420);
      return {
        description: `Error log spike: ${value} ERROR entries in 5m on ${app.runtime.service}`,
        info: { count: value, window: '5m', threshold: 100 },
      };
    },
    resolution: 'Caused by a misconfigured feature flag; flag reverted.',
  },
  {
    severity: 'warning',
    manager: 'Prometheus',
    class: 'Infrastructure',
    check: 'cpu_utilization',
    source: node,
    describe: (_app, rng) => {
      const value = rng.int(86, 96);
      return {
        description: `CPU utilization ${value}% for 15m (threshold 85%)`,
        info: { value, threshold: 85, window: '15m' },
      };
    },
    resolution: 'Autoscaler added a node; utilization back under 60%.',
  },
  {
    severity: 'minor',
    manager: 'SolarWinds',
    class: 'Infrastructure',
    check: 'tls_cert_expiry',
    source: host,
    describe: (app, rng) => {
      const value = rng.int(10, 14);
      return {
        description: `TLS certificate for ${host(app)} expires in ${value} days`,
        info: { days_left: value, issuer: 'KeyBank Issuing CA G2' },
      };
    },
    resolution: 'Certificate renewed and rolled out via cert-manager.',
  },
];

/** Low-severity alerts that stay open after reset (background noise). */
const OPEN_TEMPLATES: Template[] = [
  {
    severity: 'warning',
    manager: 'SolarWinds',
    class: 'Infrastructure',
    check: 'tls_cert_expiry',
    source: host,
    describe: (app) => ({
      description: `TLS certificate for ${host(app)} expires in 21 days`,
      info: { days_left: 21, issuer: 'KeyBank Issuing CA G2' },
    }),
    resolution: '',
  },
  {
    severity: 'minor',
    manager: 'SolarWinds',
    class: 'Infrastructure',
    check: 'disk_usage_pct',
    source: node,
    describe: () => ({
      description: 'Disk usage 83% on /var/log (threshold 80%)',
      info: { mount: '/var/log', value: 83, threshold: 80 },
    }),
    resolution: '',
  },
  {
    severity: 'warning',
    manager: 'Prometheus',
    class: 'Infrastructure',
    check: 'ntp_clock_skew',
    source: node,
    describe: (_app, rng) => {
      const value = rng.int(140, 260);
      return {
        description: `Clock skew ${value}ms vs NTP (threshold 100ms)`,
        info: { skew_ms: value, threshold_ms: 100 },
      };
    },
    resolution: '',
  },
];

const HOUR = 3_600_000;
const MIN = 60_000;

function seedAlerts(now: Date): SeedAlert[] {
  const rng = new Rng('logs-alerts');
  const world = getWorld();
  const candidates = world.apps.filter((a) => !a.hero);
  const apps = rng.pickN(candidates, TEMPLATES.length + OPEN_TEMPLATES.length);
  const t0 = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const out: SeedAlert[] = [];

  const base = (tpl: Template, app: App, first: number, last: number) => {
    const source = tpl.source(app, rng);
    const { description, info } = tpl.describe(app, rng);
    return {
      severity: tpl.severity,
      description,
      source,
      service: app.runtime.service,
      app_tla: app.tla,
      manager: tpl.manager,
      class: tpl.class,
      check: tpl.check,
      dedupe_key: `${tpl.manager.toLowerCase().replace(/\s+/g, '-')}:${source}:${tpl.check}`,
      first_event_time: iso(first),
      last_event_time: iso(last),
      event_count: rng.int(1, 12),
      incident_number: null,
      custom_info: {
        ...info,
        gcp_project: app.runtime.gcpProject,
        cluster: app.runtime.cluster,
        namespace: app.runtime.namespace,
      },
    };
  };

  TEMPLATES.forEach((tpl, i) => {
    const app = apps[i]!;
    const group = getGroup(app.supportGroupId);
    const responder = group.onCall.primary;
    // Spread over the last ~5 days, oldest first.
    const first = t0 - (5 * 24 - i * 9) * HOUR - rng.int(0, 120) * MIN;
    const ackAt = first + rng.int(4, 15) * MIN;
    const resolvedAt = ackAt + rng.int(20, 180) * MIN;
    const status: AlertStatus = t0 - resolvedAt > 48 * HOUR ? 'closed' : 'resolved';
    out.push({
      ...base(tpl, app, first, resolvedAt - rng.int(5, 15) * MIN),
      status,
      owner: responder,
      notes: [
        { at: iso(ackAt), author: responder, text: 'Acknowledged, investigating.' },
        { at: iso(resolvedAt), author: responder, text: tpl.resolution },
      ],
    });
  });

  OPEN_TEMPLATES.forEach((tpl, i) => {
    const app = apps[TEMPLATES.length + i]!;
    const first = t0 - rng.int(6, 30) * HOUR;
    const last = t0 - rng.int(10, 50) * MIN;
    const acknowledged = i === OPEN_TEMPLATES.length - 1;
    const owner = acknowledged ? getGroup(app.supportGroupId).onCall.primary : null;
    out.push({
      ...base(tpl, app, first, last),
      status: acknowledged ? 'acknowledged' : 'open',
      owner,
      notes: owner
        ? [
            {
              at: iso(first + 25 * MIN),
              author: owner,
              text: 'Known issue, change scheduled for the next maintenance window.',
            },
          ]
        : [],
    });
  });

  return out.sort((a, b) => a.first_event_time.localeCompare(b.first_event_time));
}
