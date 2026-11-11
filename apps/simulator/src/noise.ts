import type { AlertInput } from '@sim/contracts/logs';
import { type App, getWorld, type Repo, Rng, slugify } from '@sim/world';
import type { Estate } from './estate';
import type { Systems } from './systems';

export interface NoiseDeps {
  systems: Systems;
  estate: Estate;
  now(): number;
  log(message: string): void;
}

export interface NoiseTiming {
  /** Seconds between unrelated merges/commits. */
  changeEverySec: [number, number];
  /** Seconds between background alerts. */
  alertEverySec: [number, number];
  /** Seconds until a background alert clears. */
  alertClearsAfterSec: [number, number];
}

export const DEFAULT_NOISE_TIMING: NoiseTiming = {
  changeEverySec: [60, 150],
  alertEverySec: [150, 300],
  alertClearsAfterSec: [120, 300],
};

const ADR_TOPICS = [
  [
    'Adopt OpenTelemetry for distributed tracing',
    'Trace context is dropped at several hops, which makes cross-service latency analysis slow.',
  ],
  [
    'Require idempotency keys on POST endpoints',
    'Client retries after timeouts occasionally create duplicate records.',
  ],
  [
    'Standardize on structured JSON logging',
    'Free-text logs are hard to query in Cloud Logging and break saved filters.',
  ],
  [
    'Move service secrets to GCP Secret Manager',
    'Secrets are still mounted from Kubernetes secrets created by hand.',
  ],
  [
    'Retire the legacy SOAP endpoints',
    'Only two internal consumers still call the SOAP API and both have REST equivalents.',
  ],
  [
    'Adopt consumer-driven contract tests',
    'Breaking API changes have reached SIT twice this quarter.',
  ],
  [
    'Cap outbound HTTP client timeouts at 5 seconds',
    'Unbounded timeouts let slow dependencies exhaust request threads.',
  ],
  [
    'Use Flyway for schema migrations',
    'Manual DDL in change tickets has drifted between environments.',
  ],
  [
    'Enable horizontal pod autoscaling on request rate',
    'CPU-based scaling reacts too late to month-end peaks.',
  ],
  [
    'Partition Kafka topics by customer id',
    'Ordering per customer is required by downstream consumers.',
  ],
  [
    'Use read replicas for reporting queries',
    'Reporting queries compete with OLTP traffic during business hours.',
  ],
  ['Adopt feature flags for risky releases', 'Rollbacks require a full redeploy today.'],
] as const;

const RUNBOOK_TOPICS = [
  ['restart-kafka-consumers', 'Restart Kafka consumers safely'],
  ['rotate-service-account-keys', 'Rotate GCP service account keys'],
  ['drain-node-pool', 'Drain a GKE node pool before maintenance'],
  ['replay-dead-letter-queue', 'Replay messages from the dead letter queue'],
  ['failover-to-secondary-region', 'Fail over to the secondary region'],
  ['clear-stuck-batch-jobs', 'Clear stuck batch jobs'],
] as const;

const CHANGELOG_ITEMS = [
  'Bump jackson-databind to 2.17.2',
  'Bump spring-boot to 3.3.5',
  'Upgrade base image to distroless java21 (2026-10 patch)',
  'Bump undici to 6.21.0',
  'Bump fastapi to 0.115.4',
  'Tidy request logging fields',
  'Add missing unit tests for pagination',
  'Fix typo in OpenAPI description',
  'Remove unused feature flag',
  'Improve error message for invalid date ranges',
  'Update README with local setup steps',
  'Refresh test fixtures',
] as const;

const between = (rng: Rng, [min, max]: [number, number]) => rng.float(min, max) * 1000;

interface OpenBackgroundAlert {
  id: number;
  clearAt: number;
  note: string;
}

/**
 * Unrelated background activity: merges/commits to non-hero repos (with rollout logs when the
 * repo is a logging service) and low-severity Moogsoft alerts that clear on their own.
 */
export class NoiseScheduler {
  private rng: Rng;
  private nextChangeAt = 0;
  private nextAlertAt = 0;
  private open: OpenBackgroundAlert[] = [];
  private busy = false;
  private counter = 0;
  changes = 0;
  alerts = 0;
  /** Merged MRs per app that are in QV but not on a change request yet. */
  private pendingPromotion = new Map<
    string,
    { project: string; iid: number; title: string; author: string }[]
  >();

  constructor(
    private readonly deps: NoiseDeps,
    private readonly timing: NoiseTiming = DEFAULT_NOISE_TIMING,
  ) {
    this.rng = new Rng('noise');
  }

  /** Re-seeds and schedules the first events relative to now. */
  init(seed = 'noise'): void {
    const now = this.deps.now();
    this.rng = new Rng(seed);
    this.open = [];
    this.counter = 0;
    this.changes = 0;
    this.alerts = 0;
    this.pendingPromotion = new Map();
    this.nextChangeAt = now + between(this.rng, this.timing.changeEverySec);
    this.nextAlertAt =
      now + between(this.rng, [this.timing.alertEverySec[0] / 3, this.timing.alertEverySec[0] / 2]);
  }

  /** Fires whatever is due. Returns the promise of the work started (for tests). */
  tick(): Promise<void> {
    if (this.busy) return Promise.resolve();
    const now = this.deps.now();
    const tasks: (() => Promise<void>)[] = [];
    if (now >= this.nextChangeAt) {
      this.nextChangeAt = now + between(this.rng, this.timing.changeEverySec);
      tasks.push(() => this.landChange());
    }
    if (now >= this.nextAlertAt) {
      this.nextAlertAt = now + between(this.rng, this.timing.alertEverySec);
      tasks.push(() => this.raiseAlert());
    }
    const due = this.open.filter((a) => now >= a.clearAt);
    if (due.length > 0) {
      this.open = this.open.filter((a) => now < a.clearAt);
      tasks.push(() => this.clearAlerts(due));
    }
    if (tasks.length === 0) return Promise.resolve();
    this.busy = true;
    return (async () => {
      for (const task of tasks) {
        try {
          await task();
        } catch (err) {
          this.deps.log(`[noise] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })().finally(() => {
      this.busy = false;
    });
  }

  private pickRepo(): { repo: Repo; app: App } {
    const world = getWorld();
    const nonHero = world.repos.filter((r) => !world.appsByTla.get(r.tla)?.hero);
    const services = nonHero.filter((r) => {
      const app = world.appsByTla.get(r.tla)!;
      return app.emitsLogs && r.name === app.runtime.service;
    });
    const repo = this.rng.chance(0.6) ? this.rng.pick(services) : this.rng.pick(nonHero);
    return { repo, app: world.appsByTla.get(repo.tla)! };
  }

  private async landChange(): Promise<void> {
    const { repo, app } = this.pickRepo();
    const { gitlab } = this.deps.systems;
    const rng = this.rng;
    const devs = app.developerUsernames.length > 0 ? app.developerUsernames : ['svc_gitlab_ci'];
    const author = rng.pick(devs);
    const mergedBy = devs.find((u) => u !== author) ?? author;
    const kind = rng.weighted([
      ['changelog', 45],
      ['adr', 35],
      ['runbook', 20],
    ] as const);
    this.counter++;

    let title: string;
    let description: string;
    let branch: string;
    let labels: string[];
    let path: string;
    let content: string;

    if (kind === 'changelog') {
      const existing = await gitlab.getRawFile(repo.path, 'CHANGELOG.md', 'main');
      const current = existing?.match(/##\s*\[?(\d+)\.(\d+)\.(\d+)/);
      const [maj, min, pat] = current
        ? [Number(current[1]), Number(current[2]), Number(current[3])]
        : this.deps.estate.get(app, app.runtime.service).semver;
      const version = `${maj}.${min}.${pat + 1}`;
      const items = rng.pickN(CHANGELOG_ITEMS, rng.int(1, 3));
      const date = new Date(this.deps.now()).toISOString().slice(0, 10);
      const section = `## [${version}] - ${date}\n\n### Changed\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
      const base =
        existing ?? '# Changelog\n\nAll notable changes to this project are documented here.\n\n';
      const at = base.search(/^## /m);
      content =
        at >= 0 ? base.slice(0, at) + section + base.slice(at) : `${base.trimEnd()}\n\n${section}`;
      path = 'CHANGELOG.md';
      title = `chore(release): ${version}`;
      description = `Release notes for ${version}.\n\n${items.map((i) => `- ${i}`).join('\n')}`;
      branch = `release/${version}`;
      labels = ['release'];
    } else if (kind === 'adr') {
      const [topic, context] = rng.pick(ADR_TOPICS);
      let n = rng.int(12, 60);
      path = `docs/adr/${String(n).padStart(4, '0')}-${slugify(topic)}.md`;
      for (let i = 0; i < 5 && (await gitlab.getRawFile(repo.path, path, 'main')) !== null; i++) {
        n++;
        path = `docs/adr/${String(n).padStart(4, '0')}-${slugify(topic)}.md`;
      }
      content = [
        `# ${String(n).padStart(4, '0')}. ${topic}`,
        '',
        `Date: ${new Date(this.deps.now()).toISOString().slice(0, 10)}`,
        '',
        '## Status',
        '',
        'Accepted',
        '',
        '## Context',
        '',
        `${context} This affects ${app.name} (${app.tla}).`,
        '',
        '## Decision',
        '',
        `${topic} for ${repo.name}, following the platform engineering guidance.`,
        '',
        '## Consequences',
        '',
        '- Small one-off migration effort, tracked in the team backlog.',
        '- No change to the public API.',
        '',
      ].join('\n');
      title = `docs: ADR-${String(n).padStart(4, '0')} ${topic.toLowerCase()}`;
      description = `Records the decision to ${topic.toLowerCase()}.\n\nNo code changes.`;
      branch = `docs/adr-${String(n).padStart(4, '0')}`;
      labels = ['documentation'];
    } else {
      const [slug, heading] = rng.pick(RUNBOOK_TOPICS);
      path = `docs/runbooks/${slug}.md`;
      const exists = (await gitlab.getRawFile(repo.path, path, 'main')) !== null;
      if (exists) path = `docs/runbooks/${slug}-${this.counter}.md`;
      content = [
        `# ${heading}`,
        '',
        `Applies to: ${repo.name} (${app.tla})`,
        '',
        '## When to use',
        '',
        'During planned maintenance or when directed by the incident commander.',
        '',
        '## Steps',
        '',
        `1. Announce the change in the ${app.tla} support channel.`,
        `2. Check current state: \`kubectl -n ${app.runtime.namespace} get pods\`.`,
        '3. Perform the change, one replica at a time.',
        '4. Confirm error rate and latency are back to baseline in Cloud Logging.',
        '',
      ].join('\n');
      title = `docs: add runbook "${heading.toLowerCase()}"`;
      description = `Adds an operational runbook for ${repo.name}.`;
      branch = `docs/runbook-${slug}`;
      labels = ['documentation'];
    }

    const edits = [{ path, content }];
    const asCommit = kind === 'changelog' ? rng.chance(0.4) : rng.chance(0.15);
    let url: string;
    if (asCommit) {
      const res = await gitlab.adminCommit({ project: repo.path, message: title, author, edits });
      url = res.web_url;
    } else {
      const res = await gitlab.adminMerge({
        project: repo.path,
        title,
        description,
        author,
        merged_by: mergedBy,
        source_branch: branch,
        labels,
        edits,
        opened_minutes_ago: rng.int(30, 60 * 24 * 3),
      });
      url = res.web_url;
      const pending = this.pendingPromotion.get(app.tla) ?? [];
      pending.push({ project: repo.path, iid: res.iid, title, author });
      this.pendingPromotion.set(app.tla, pending);
    }
    this.changes++;
    this.deps.log(`[noise] ${asCommit ? 'commit' : 'merge'} ${repo.path}: ${title} (${url})`);
    // Merges sit in QV until someone raises a change request; sometimes several ride together.
    if (!asCommit && rng.chance(0.6)) await this.raiseChange(app);
  }

  /** Change request for everything of `app` waiting in QV, scheduled a few minutes out. */
  private async raiseChange(app: App): Promise<void> {
    const pending = this.pendingPromotion.get(app.tla) ?? [];
    if (pending.length === 0) return;
    this.pendingPromotion.delete(app.tla);
    const last = pending.at(-1)!;
    const repo = last.project.split('/').at(-1)!;
    const change = await this.deps.systems.servicenow.createChange({
      short_description: (pending.length === 1
        ? `${repo}: ${last.title}`
        : `${app.tla}: promote ${pending.length} changes to production`
      ).slice(0, 160),
      description: pending.map((p) => `- ${p.project}!${p.iid} ${p.title}`).join('\n'),
      app_tla: app.tla,
      merge_requests: pending.map((p) => `${p.project}!${p.iid}`),
      planned_start: `+${this.rng.int(2, 12)}m`,
      type: 'standard',
      risk: 'low',
      requested_by: last.author,
    });
    this.deps.log(
      `[noise] ${change.number} scheduled for ${change.planned_start} (${pending.length} MR${pending.length === 1 ? '' : 's'} of ${app.tla})`,
    );
  }

  private async raiseAlert(): Promise<void> {
    const world = getWorld();
    const candidates = world.apps.filter((a) => a.emitsLogs && !a.hero);
    const app = this.rng.pick(candidates);
    const rt = this.deps.estate.get(app);
    const pod = this.rng.pick(rt.pods);
    const node = `gke-${app.runtime.cluster.replace(/^gke-/, '')}-pool-${this.rng.int(1, 3)}-${this.rng.hex(8)}`;
    const kind = this.rng.pick(['disk', 'cpu', 'memory', 'cert'] as const);
    let input: AlertInput;
    let note: string;
    switch (kind) {
      case 'disk': {
        const pct = this.rng.int(86, 92);
        input = {
          severity: 'warning',
          description: `Disk usage ${pct}% on ${node} /var/lib/containerd (threshold 85%)`,
          source: node,
          service: app.runtime.service,
          app_tla: app.tla,
          manager: 'SolarWinds',
          class: 'Infrastructure',
          check: 'disk_used_percent',
          dedupe_key: `bg:disk:${node}`,
          custom_info: { mount: '/var/lib/containerd', value: pct, threshold: 85 },
        };
        note = 'Auto-cleared: image garbage collection freed space, disk usage 71%';
        break;
      }
      case 'cpu': {
        const pct = this.rng.int(91, 97);
        input = {
          severity: 'minor',
          description: `CPU utilization ${pct}% on ${pod} for 5m (threshold 90%)`,
          source: pod,
          service: app.runtime.service,
          app_tla: app.tla,
          manager: 'Prometheus',
          class: 'Infrastructure',
          check: 'container_cpu_utilization',
          dedupe_key: `bg:cpu:${app.runtime.service}`,
          custom_info: { value: pct, threshold: 90, window: '5m' },
        };
        note = 'Auto-cleared: CPU utilization back below threshold';
        break;
      }
      case 'memory': {
        const pct = this.rng.int(86, 93);
        input = {
          severity: 'warning',
          description: `Memory working set ${pct}% of limit on ${pod} (threshold 85%)`,
          source: pod,
          service: app.runtime.service,
          app_tla: app.tla,
          manager: 'Prometheus',
          class: 'Infrastructure',
          check: 'container_memory_working_set_percent',
          dedupe_key: `bg:mem:${app.runtime.service}`,
          custom_info: { value: pct, threshold: 85 },
        };
        note = 'Auto-cleared: memory working set back below threshold';
        break;
      }
      default: {
        const days = this.rng.int(9, 14);
        const host = `${app.runtime.service}.${app.runtime.namespace}.svc.keybank.internal`;
        input = {
          severity: 'warning',
          description: `TLS certificate for ${host} expires in ${days} days`,
          source: `${host}:443`,
          service: app.runtime.service,
          app_tla: app.tla,
          manager: 'GCP Monitoring',
          class: 'Security',
          check: 'tls_cert_expiry_days',
          dedupe_key: `bg:cert:${host}`,
          custom_info: { days_remaining: days, issuer: 'KeyBank Internal Issuing CA 2' },
        };
        note = 'Auto-cleared: certificate renewed by cert-manager (expires in 90 days)';
      }
    }
    const alert = await this.deps.systems.logs.raiseAlert(input);
    this.alerts++;
    this.open.push({
      id: alert.id,
      clearAt: this.deps.now() + between(this.rng, this.timing.alertClearsAfterSec),
      note,
    });
    this.deps.log(`[noise] alert #${alert.id} ${input.severity}: ${input.description}`);
  }

  private async clearAlerts(due: OpenBackgroundAlert[]): Promise<void> {
    for (const a of due) {
      try {
        await this.deps.systems.logs.updateAlert(a.id, {
          status: 'resolved',
          note: { author: 'moogsoft', text: a.note },
        });
      } catch (err) {
        this.deps.log(
          `[noise] clearing alert #${a.id} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
