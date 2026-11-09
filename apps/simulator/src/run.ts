import type { LogEntryInput } from '@sim/contracts/logs';
import {
  isRunActive,
  type RunEvent,
  type RunEventKind,
  type RunPhase,
  type RunStatus,
} from '@sim/contracts/simulator';
import type { LogTemplate, ScenarioDefinition } from '@sim/scenarios';
import { type App, getWorld, Rng, shaFor, slugify } from '@sim/world';
import { type Estate, lineFromRendered } from './estate';
import type { Systems } from './systems';
import { makeLogContext } from './values';

/** Seconds (scenario time) for symptoms to ramp up after onset, and down after a fix. */
export const RAMP_SEC = 20;

export interface RunDeps {
  systems: Systems;
  estate: Estate;
  /** Queue entries for ingest (future timestamps are held until due). */
  emit(entries: LogEntryInput[]): void;
  /** Roll out `sha` for a service: bumps version, rolls pods, emits rollout lines. */
  deploy(app: App, service: string, sha: string, durationSec: number): void;
  logsWebUrl: string;
  now(): number;
  log(message: string): void;
}

interface Stream {
  kind: 'impact' | 'fanout' | 'culprit';
  app: App;
  service: string;
  /** Scenario seconds after the merge when this stream starts. */
  onsetSec: number;
  ratePerSec: number;
  templates: LogTemplate[];
  carry: number;
  rng: Rng;
}

interface TrackedAlert {
  id: number;
  web_url: string;
  severity: RunStatus['alerts'][number]['severity'];
  app_tla: string;
  description: string;
  resolved: boolean;
}

/** Resolves a GitLab project path to the app and the workload a merge to it rolls out. */
export function serviceForProject(
  project: string,
): { app: App; service: string; deployable: boolean } | null {
  const world = getWorld();
  const repo = world.reposByPath.get(project);
  const tla = repo?.tla ?? project.split('/')[1]?.replace(/00$/, '');
  const app = tla ? world.appsByTla.get(tla) : undefined;
  if (!app) return null;
  if (repo && (repo.kind === 'service' || repo.kind === 'batch')) {
    return { app, service: repo.name, deployable: true };
  }
  return { app, service: app.runtime.service, deployable: false };
}

/** Apps that a scenario's fanout reaches (first matching fanout wins). */
export function fanoutTargets(scenario: ScenarioDefinition): { fanoutIndex: number; app: App }[] {
  const world = getWorld();
  const explicit = new Set(scenario.impacts.map((i) => i.tla.toUpperCase()));
  const culprit = scenario.answerKey.culpritTla.toUpperCase();
  const assigned = new Set<string>();
  const out: { fanoutIndex: number; app: App }[] = [];
  (scenario.fanout ?? []).forEach((f, fanoutIndex) => {
    const upstream = f.upstreamTla.toUpperCase();
    for (const app of world.apps) {
      if (!app.emitsLogs || !app.upstream.includes(upstream)) continue;
      if (explicit.has(app.tla) || assigned.has(app.tla) || app.tla === culprit) continue;
      assigned.add(app.tla);
      out.push({ fanoutIndex, app });
    }
  });
  return out;
}

export function logsExplorerUrl(logsWebUrl: string, tlas: string[]): string {
  const unique = [...new Set(tlas.map((t) => t.toUpperCase()))];
  const apps =
    unique.length === 1
      ? `labels.app_tla="${unique[0]}"`
      : `(${unique.map((t) => `labels.app_tla="${t}"`).join(' OR ')})`;
  return `${logsWebUrl}/logs?query=${encodeURIComponent(`severity>=WARNING AND ${apps}`)}`;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One scenario run. Time-driven: the engine calls `tick` every second (returns log entries) and
 * `checkFix` every few seconds. Offsets in the scenario are divided by `speed`.
 */
export class ScenarioRun {
  phase: RunPhase = 'pending';
  readonly startedAtMs: number;
  private readonly events: RunEvent[] = [];
  private readonly streams: Stream[] = [];
  private readonly alertNextAt: number[];
  private readonly alertFailures: number[];
  private readonly helpdeskFired: boolean[];
  private readonly herringFired: boolean[];
  private readonly alerts = new Map<number, TrackedAlert>();
  private readonly helpdesk: RunStatus['helpdesk'] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly culprit: { app: App; service: string };
  private badMr: RunStatus['bad_mr'] = null;
  private fixMr: RunStatus['fix_mr'] = null;
  private fixedAtSec: number | null = null;
  private fixedAtMs: number | null = null;
  private faultOnsetAtMs: number | null = null;
  private recoveredAtMs: number | null = null;
  private endedAtMs: number | null = null;
  private error: string | null = null;
  private checkingFix = false;
  private fixCheckErrors = 0;

  constructor(
    readonly scenario: ScenarioDefinition,
    readonly speed: number,
    private readonly deps: RunDeps,
  ) {
    this.startedAtMs = deps.now();
    const world = getWorld();
    const culpritTla = scenario.answerKey.culpritTla.toUpperCase();
    const culpritApp = world.appsByTla.get(culpritTla);
    if (!culpritApp) throw new Error(`Scenario ${scenario.id}: unknown culprit TLA ${culpritTla}`);
    const target = serviceForProject(scenario.badMr.project);
    this.culprit = {
      app: culpritApp,
      service:
        target && target.app.tla === culpritTla ? target.service : culpritApp.runtime.service,
    };

    const seed = `run:${scenario.id}`;
    const stream = (
      kind: Stream['kind'],
      app: App,
      service: string,
      startAfterSec: number,
      ratePerSec: number,
      templates: LogTemplate[],
    ): Stream => ({
      kind,
      app,
      service,
      onsetSec: scenario.faultOnsetSec + startAfterSec,
      ratePerSec,
      templates,
      carry: 0,
      rng: new Rng(`${seed}:${kind}:${app.tla}:${service}`),
    });

    if (scenario.culpritSignals && scenario.culpritSignals.templates.length > 0) {
      this.streams.push(
        stream(
          'culprit',
          this.culprit.app,
          this.culprit.service,
          0,
          scenario.culpritSignals.ratePerSec,
          scenario.culpritSignals.templates,
        ),
      );
    }
    for (const impact of scenario.impacts) {
      const app = world.appsByTla.get(impact.tla.toUpperCase());
      if (!app || impact.templates.length === 0) continue;
      this.streams.push(
        stream(
          'impact',
          app,
          impact.service ?? app.runtime.service,
          impact.startAfterSec,
          impact.ratePerSec,
          impact.templates,
        ),
      );
    }
    for (const { fanoutIndex, app } of fanoutTargets(scenario)) {
      const f = scenario.fanout![fanoutIndex]!;
      const templates = f.templates(app, app.stack);
      if (templates.length === 0) continue;
      this.streams.push(
        stream('fanout', app, app.runtime.service, f.startAfterSec, f.ratePerSec, templates),
      );
    }

    this.alertNextAt = scenario.alerts.map((a) => a.atSec);
    this.alertFailures = scenario.alerts.map(() => 0);
    this.helpdeskFired = (scenario.helpdesk ?? []).map(() => false);
    this.herringFired = (scenario.redHerrings ?? []).map(() => false);
  }

  get id(): string {
    return this.scenario.id;
  }

  get active(): boolean {
    return isRunActive(this.phase);
  }

  /** Scenario seconds since the bad MR merged (wall clock × speed). */
  scenarioSec(nowMs = this.deps.now()): number {
    return ((nowMs - this.startedAtMs) / 1000) * this.speed;
  }

  /** Streams that emit symptoms (for tests and the scenario detail view). */
  get streamSummary(): {
    kind: Stream['kind'];
    tla: string;
    service: string;
    onsetSec: number;
    ratePerSec: number;
  }[] {
    return this.streams.map((s) => ({
      kind: s.kind,
      tla: s.app.tla,
      service: s.service,
      onsetSec: s.onsetSec,
      ratePerSec: s.ratePerSec,
    }));
  }

  /** t=0: merge the bad MR and roll it out. Throws (and marks the run failed) on error. */
  async start(): Promise<void> {
    const mr = this.scenario.badMr;
    try {
      const res = await this.deps.systems.gitlab.adminMerge({
        project: mr.project,
        title: mr.title,
        description: mr.description,
        author: mr.author,
        merged_by: mr.mergedBy,
        source_branch: mr.sourceBranch,
        labels: mr.labels,
        approvers: mr.approvers,
        edits: mr.edits,
        opened_minutes_ago: mr.openedMinutesAgo,
      });
      const sha = res.merge_commit.id;
      this.badMr = {
        web_url: res.web_url,
        sha,
        short_sha: res.merge_commit.short_id || sha.slice(0, 7),
        iid: res.iid,
      };
      this.addEvent(
        'merge',
        `Bad MR !${res.iid} merged: "${mr.title}" (${mr.project}, ${this.badMr.short_sha})`,
        res.web_url,
      );
      const rolloutSec = Math.max(2, Math.min(20, this.scenario.faultOnsetSec / this.speed));
      this.deps.deploy(this.culprit.app, this.culprit.service, sha, rolloutSec);
      this.addEvent('deploy', `Rolling out ${this.culprit.service} ${this.badMr.short_sha}`);
    } catch (err) {
      this.phase = 'failed';
      this.error = `Bad MR merge failed: ${errorMessage(err)}`;
      this.endedAtMs = this.deps.now();
      this.addEvent('error', this.error);
      throw err;
    }
  }

  /** Advances the run to `nowMs`; returns symptom log lines for the last `dtSec` seconds. */
  tick(nowMs: number, dtSec: number): LogEntryInput[] {
    if (!this.active) return [];
    const sec = this.scenarioSec(nowMs);

    if (this.phase === 'pending' && sec >= this.scenario.faultOnsetSec) {
      this.phase = 'degrading';
      this.faultOnsetAtMs = nowMs;
      this.addEvent(
        'fault',
        `Fault active: ${this.culprit.service} rollout complete, symptoms starting`,
      );
    }
    if (
      this.phase === 'recovering' &&
      this.fixedAtSec !== null &&
      sec >= this.fixedAtSec + RAMP_SEC
    ) {
      this.phase = 'recovered';
      this.recoveredAtMs = nowMs;
      this.endedAtMs = nowMs;
      this.track(this.resolveAlerts());
    }

    this.fireDue(sec);

    const out: LogEntryInput[] = [];
    if (dtSec <= 0) return out;
    for (const s of this.streams) {
      const intensity = this.intensity(s, sec);
      if (intensity <= 0) continue;
      s.carry += s.ratePerSec * intensity * dtSec;
      const n = Math.floor(s.carry);
      s.carry -= n;
      if (n === 0) continue;
      const rt = this.deps.estate.get(s.app, s.service);
      const choices = s.templates.map((t) => [t, t.weight ?? 1] as const);
      for (let i = 0; i < n; i++) {
        const ts = new Date(nowMs - s.rng.next() * dtSec * 1000);
        const template = s.rng.weighted(choices);
        const ctx = makeLogContext({
          rng: s.rng,
          app: s.app,
          service: s.service,
          now: ts,
          elapsedSec: Math.max(0, sec - s.onsetSec),
        });
        try {
          const rendered = template.render(ctx);
          out.push(
            this.deps.estate.entry(rt, lineFromRendered(template.severity, rendered), ts, s.rng),
          );
        } catch (err) {
          this.deps.log(`[run ${this.id}] template for ${s.app.tla} failed: ${errorMessage(err)}`);
        }
      }
    }
    return out;
  }

  /** 0..1 symptom intensity of a stream at scenario second `sec`. */
  intensity(s: Pick<Stream, 'onsetSec'>, sec: number): number {
    if (this.phase === 'stopped' || this.phase === 'failed') return 0;
    if (sec < s.onsetSec) return 0;
    let v = Math.min(1, (sec - s.onsetSec) / RAMP_SEC);
    if (this.fixedAtSec !== null) v *= Math.max(0, 1 - (sec - this.fixedAtSec) / RAMP_SEC);
    return v;
  }

  private fireDue(sec: number): void {
    const faultActive = this.phase === 'pending' || this.phase === 'degrading';
    if (faultActive) {
      this.scenario.alerts.forEach((a, i) => {
        if (sec < this.alertNextAt[i]!) return;
        // Next repeat; never burst to catch up.
        this.alertNextAt[i] = a.repeatEverySec
          ? Math.max(this.alertNextAt[i]! + a.repeatEverySec, sec + a.repeatEverySec / 2)
          : Number.POSITIVE_INFINITY;
        this.track(this.raiseAlert(i));
      });
      (this.scenario.helpdesk ?? []).forEach((h, i) => {
        if (this.helpdeskFired[i] || sec < h.atSec) return;
        this.helpdeskFired[i] = true;
        this.track(this.openHelpdesk(i));
      });
    }
    (this.scenario.redHerrings ?? []).forEach((h, i) => {
      if (this.herringFired[i] || sec < h.atSec) return;
      this.herringFired[i] = true;
      this.track(this.landHerring(i));
    });
  }

  private async raiseAlert(index: number): Promise<void> {
    const def = this.scenario.alerts[index]!;
    try {
      const alert = await this.deps.systems.logs.raiseAlert(def.alert);
      const known = this.alerts.get(alert.id);
      if (known) return;
      const tracked: TrackedAlert = {
        id: alert.id,
        web_url: `${this.deps.logsWebUrl}/alerts/${alert.id}`,
        severity: alert.severity ?? def.alert.severity,
        app_tla: alert.app_tla ?? def.alert.app_tla,
        description: alert.description ?? def.alert.description,
        resolved: false,
      };
      this.alerts.set(alert.id, tracked);
      this.addEvent(
        'alert',
        `Moogsoft alert #${alert.id} (${tracked.severity}) ${tracked.app_tla}: ${tracked.description}`,
        tracked.web_url,
      );
      // Raised while the run was already recovering/recovered: clear it right away.
      if (this.phase === 'recovered') await this.resolveAlerts(false);
    } catch (err) {
      if (this.alertFailures[index]!++ === 0) {
        this.addEvent(
          'error',
          `Raising alert "${def.alert.description}" failed: ${errorMessage(err)}`,
        );
      }
    }
  }

  private async openHelpdesk(index: number): Promise<void> {
    const call = this.scenario.helpdesk![index]!;
    try {
      const ref = await this.deps.systems.servicenow.createIncident(call.incident);
      this.helpdesk.push({
        number: ref.number,
        web_url: ref.web_url,
        at: new Date(this.deps.now()).toISOString(),
      });
      const who = call.incident.caller ? ` (caller ${call.incident.caller})` : '';
      this.addEvent(
        'helpdesk',
        `${ref.number} opened${who}: ${ref.short_description ?? call.incident.short_description}`,
        ref.web_url,
      );
    } catch (err) {
      this.addEvent(
        'error',
        `Help desk incident "${call.incident.short_description}" failed: ${errorMessage(err)}`,
      );
    }
  }

  private async landHerring(index: number): Promise<void> {
    const h = this.scenario.redHerrings![index]!;
    try {
      let url: string;
      let sha: string;
      if (h.kind === 'merge') {
        const target = serviceForProject(h.project);
        const mergedBy =
          h.mergedBy ?? target?.app.developerUsernames.find((u) => u !== h.author) ?? h.author;
        const res = await this.deps.systems.gitlab.adminMerge({
          project: h.project,
          title: h.title,
          description: h.description ?? '',
          author: h.author,
          merged_by: mergedBy,
          source_branch: h.sourceBranch ?? `feature/${slugify(h.title).slice(0, 40)}`,
          labels: h.labels,
          edits: h.edits,
        });
        url = res.web_url;
        sha = res.merge_commit.id;
      } else {
        const res = await this.deps.systems.gitlab.adminCommit({
          project: h.project,
          message: h.title,
          author: h.author,
          edits: h.edits,
        });
        url = res.web_url;
        sha = res.id;
      }
      this.addEvent('red_herring', `Red herring ${h.kind}: "${h.title}" (${h.project})`, url);
      const target = serviceForProject(h.project);
      if (target?.deployable && target.app.emitsLogs) {
        this.deps.deploy(target.app, target.service, sha, 20);
      }
    } catch (err) {
      this.addEvent('error', `Red herring "${h.title}" failed: ${errorMessage(err)}`);
    }
  }

  /** Reads `fix.files` from main and evaluates `fix.isFixed`. Returns true when the fix landed. */
  async checkFix(): Promise<boolean> {
    if (
      !(this.phase === 'pending' || this.phase === 'degrading') ||
      this.checkingFix ||
      !this.badMr
    ) {
      return false;
    }
    this.checkingFix = true;
    const { fix, badMr } = this.scenario;
    try {
      const files: Record<string, string | null> = {};
      for (const path of fix.files) {
        files[path] = await this.deps.systems.gitlab.getRawFile(badMr.project, path, 'main');
      }
      if (!(this.phase === 'pending' || this.phase === 'degrading')) return false;
      if (!fix.isFixed(files)) return false;
      await this.markFixed();
      return true;
    } catch (err) {
      if (this.fixCheckErrors++ === 0)
        this.addEvent('error', `Fix check failed: ${errorMessage(err)}`);
      return false;
    } finally {
      this.checkingFix = false;
    }
  }

  private async markFixed(): Promise<void> {
    const now = this.deps.now();
    this.phase = 'recovering';
    this.fixedAtSec = this.scenarioSec(now);
    this.fixedAtMs = now;
    const project = this.scenario.badMr.project;
    let change: Awaited<ReturnType<NonNullable<Systems['gitlab']['latestMainChange']>>> = null;
    try {
      change =
        (await this.deps.systems.gitlab.latestMainChange?.(project, this.badMr?.sha)) ?? null;
    } catch {
      change = null;
    }
    if (change) this.fixMr = { web_url: change.web_url, sha: change.sha };
    this.addEvent(
      'fix',
      change ? `Fix detected on main: "${change.title}"` : `Fix detected on main of ${project}`,
      change?.web_url,
    );
    const sha = change?.sha ?? shaFor(`fix:${this.id}:${now}`);
    this.deps.deploy(
      this.culprit.app,
      this.culprit.service,
      sha,
      Math.max(2, RAMP_SEC / this.speed),
    );
    this.addEvent(
      'deploy',
      `Rolling out ${this.culprit.service} ${sha.slice(0, 7)}; errors ramping down`,
    );
  }

  private async resolveAlerts(announce = true): Promise<void> {
    const open = [...this.alerts.values()].filter((a) => !a.resolved);
    let resolved = 0;
    for (const alert of open) {
      try {
        await this.deps.systems.logs.updateAlert(alert.id, {
          status: 'resolved',
          note: { author: 'moogsoft', text: 'Auto-resolved: error rate back below threshold' },
        });
        alert.resolved = true;
        resolved++;
      } catch (err) {
        this.addEvent('error', `Resolving alert #${alert.id} failed: ${errorMessage(err)}`);
      }
    }
    if (announce) {
      this.addEvent(
        'recovered',
        `Error rates back to baseline${resolved > 0 ? `; auto-resolved ${resolved} alert${resolved === 1 ? '' : 's'}` : ''}`,
      );
    }
  }

  stop(reason: string): void {
    if (!this.active) return;
    this.phase = 'stopped';
    this.endedAtMs = this.deps.now();
    this.addEvent('stopped', reason);
  }

  /** Resolves once every in-flight system call has settled (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private addEvent(kind: RunEventKind, message: string, url?: string): void {
    const now = this.deps.now();
    const event: RunEvent = {
      at: new Date(now).toISOString(),
      offset_sec: Math.round((now - this.startedAtMs) / 100) / 10,
      kind,
      message,
    };
    if (url) event.url = url;
    this.events.push(event);
    this.deps.log(`[run ${this.id}] +${event.offset_sec}s ${kind}: ${message}`);
  }

  status(): RunStatus {
    const now = this.deps.now();
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const { answerKey } = this.scenario;
    return {
      id: this.scenario.id,
      title: this.scenario.title,
      kind: this.scenario.kind,
      phase: this.phase,
      active: this.active,
      speed: this.speed,
      started_at: new Date(this.startedAtMs).toISOString(),
      elapsed_sec: Math.round(((this.endedAtMs ?? now) - this.startedAtMs) / 1000),
      fault_onset_at: iso(this.faultOnsetAtMs),
      fixed_at: iso(this.fixedAtMs),
      recovered_at: iso(this.recoveredAtMs),
      ended_at: iso(this.endedAtMs),
      error: this.error,
      bad_mr: this.badMr,
      fix_mr: this.fixMr,
      helpdesk: [...this.helpdesk],
      alerts: [...this.alerts.values()].map((a) => ({ ...a })),
      culprit_tla: answerKey.culpritTla,
      affected_tlas: answerKey.affectedTlas,
      logs_url: logsExplorerUrl(this.deps.logsWebUrl, [
        answerKey.culpritTla,
        ...answerKey.affectedTlas,
      ]),
      events: [...this.events],
    };
  }
}
