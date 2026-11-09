import { HttpError } from '@sim/api-kit';
import { SYSTEMS, type SystemName } from '@sim/contracts';
import type { LogEntryInput } from '@sim/contracts/logs';
import type {
  EndpointHealth,
  EnginePhase,
  ResetResponse,
  RunStatus,
  SimulatorStatus,
  SystemStatus,
  TrafficInput,
  TrafficStatus,
  TriggerInput,
} from '@sim/contracts/simulator';
import type { ScenarioDefinition } from '@sim/scenarios';
import type { App } from '@sim/world';
import { Estate } from './estate';
import { DEFAULT_NOISE_TIMING, NoiseScheduler, type NoiseTiming } from './noise';
import { type RunDeps, ScenarioRun } from './run';
import { checkHealth, type HealthChecker, type SimulatorConfig, type Systems } from './systems';
import { buildProfiles, TrafficGenerator, type TrafficProfile } from './traffic';

export interface EngineOptions {
  config: SimulatorConfig;
  systems: Systems;
  scenarios: ScenarioDefinition[];
  now?: () => number;
  log?: (message: string) => void;
  healthCheck?: HealthChecker;
  noiseTiming?: NoiseTiming;
  backfillMinutes?: number;
  tickMs?: number;
  fixCheckMs?: number;
  healthEveryMs?: number;
}

const INGEST_BATCH = 2000;
const MAX_BUFFER = 50_000;
const RATE_WINDOW_MS = 10_000;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Engine {
  phase: EnginePhase = 'waiting_for_systems';
  private message: string | null = 'Waiting for systems';
  private readonly startedAt = new Date().toISOString();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly healthCheck: HealthChecker;
  private readonly profiles: TrafficProfile[];
  private estate: Estate;
  private traffic: TrafficGenerator;
  private noise: NoiseScheduler;
  private run: ScenarioRun | null = null;
  private buffer: LogEntryInput[] = [];
  private delayed: LogEntryInput[] = [];
  private lastTickMs: number;
  private paused = false;
  private rateMultiplier = 1;
  private totalLines = 0;
  private ingestErrors = 0;
  private lastIngestError: string | null = null;
  private lastFlushAt: string | null = null;
  private flushHistory: { at: number; n: number }[] = [];
  private flushing: Promise<void> | null = null;
  private health = new Map<string, EndpointHealth>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private resetting: Promise<ResetResponse> | null = null;
  private noiseTask: Promise<void> | null = null;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[simulator] ${m}`));
    this.healthCheck = opts.healthCheck ?? ((url) => checkHealth(url));
    this.profiles = buildProfiles();
    this.estate = new Estate();
    this.traffic = new TrafficGenerator(this.estate, this.profiles);
    this.noise = this.createNoise();
    this.lastTickMs = this.now();
  }

  get scenarios(): ScenarioDefinition[] {
    return this.opts.scenarios;
  }

  /** Waits for the four APIs, backfills history, then starts live traffic. */
  async boot(): Promise<void> {
    this.startHealthLoop();
    await this.waitForSystems();
    const populated = await this.logsAlreadyPopulated();
    if (this.opts.config.skipBackfill || populated) {
      this.log(
        populated
          ? `Logs API already holds ${populated} entries; skipping backfill (POST /api/reset to start clean)`
          : 'SKIP_BACKFILL set; skipping backfill',
      );
      this.traffic.init(this.now());
    } else {
      await this.backfill();
    }
    this.startLive();
  }

  private createNoise(): NoiseScheduler {
    return new NoiseScheduler(
      {
        systems: this.opts.systems,
        estate: this.estate,
        deploy: (app, service, sha, sec) => this.deploy(app, service, sha, sec),
        now: this.now,
        log: this.log,
      },
      this.opts.noiseTiming ?? DEFAULT_NOISE_TIMING,
    );
  }

  private runDeps(): RunDeps {
    return {
      systems: this.opts.systems,
      estate: this.estate,
      emit: (entries) => this.emit(entries),
      deploy: (app, service, sha, sec) => this.deploy(app, service, sha, sec),
      logsWebUrl: this.opts.config.systems.logs.web,
      now: this.now,
      log: this.log,
    };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  private endpoints(): { key: string; url: string }[] {
    return SYSTEMS.flatMap((name) => {
      const s = this.opts.config.systems[name];
      return [
        { key: `${name}:api`, url: `${s.api}/health` },
        { key: `${name}:mcp`, url: s.mcpHealth },
      ];
    });
  }

  async refreshHealth(): Promise<void> {
    await Promise.all(
      this.endpoints().map(async ({ key, url }) => {
        this.health.set(key, await this.healthCheck(url));
      }),
    );
  }

  private startHealthLoop(): void {
    void this.refreshHealth();
    this.timers.push(setInterval(() => void this.refreshHealth(), this.opts.healthEveryMs ?? 3000));
  }

  private async waitForSystems(): Promise<void> {
    this.phase = 'waiting_for_systems';
    let lastReport = '';
    let lastReportAt = 0;
    for (;;) {
      const checks = await Promise.all(
        SYSTEMS.map(async (name) => ({
          name,
          health: await this.healthCheck(`${this.opts.config.systems[name].api}/health`),
        })),
      );
      for (const c of checks) this.health.set(`${c.name}:api`, c.health);
      const down = checks.filter((c) => !c.health.ok);
      if (down.length === 0) {
        this.log('All four system APIs are healthy');
        return;
      }
      const report = down.map((c) => `${c.name} (${c.health.error})`).join(', ');
      this.message = `Waiting for ${down.map((c) => c.name).join(', ')}`;
      if (report !== lastReport || this.now() - lastReportAt > 15_000) {
        this.log(`Waiting for systems: ${report}`);
        lastReport = report;
        lastReportAt = this.now();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** Entry count from the Logs API health stats when it already holds lots of history. */
  private async logsAlreadyPopulated(): Promise<number> {
    const health = await this.healthCheck(`${this.opts.config.systems.logs.api}/health`);
    const stats = health.stats ?? {};
    for (const key of ['entries', 'log_entries', 'total_entries', 'logs', 'lines']) {
      const value = stats[key];
      if (typeof value === 'number' && value >= 5000) return value;
    }
    return 0;
  }

  // -------------------------------------------------------------------------
  // Traffic
  // -------------------------------------------------------------------------

  /** Writes `minutes` of baseline history (past timestamps) in batches. Returns lines written. */
  async backfill(minutes = this.opts.backfillMinutes ?? 20): Promise<number> {
    const prev = this.phase;
    this.phase = 'backfilling';
    this.message = `Backfilling ${minutes} minutes of traffic`;
    const end = this.now();
    const start = end - minutes * 60_000;
    this.traffic.init(start);
    this.log(`Backfilling ${minutes} minutes of baseline traffic`);
    let written = 0;
    let batch: LogEntryInput[] = [];
    const send = async () => {
      if (batch.length === 0) return;
      batch.sort(byTimestamp);
      const chunk = batch;
      batch = [];
      for (let attempt = 1; ; attempt++) {
        try {
          await this.opts.systems.logs.ingest({ entries: chunk });
          written += chunk.length;
          this.totalLines += chunk.length;
          return;
        } catch (err) {
          if (attempt >= 3) {
            this.ingestErrors++;
            this.lastIngestError = errorMessage(err);
            this.log(`Backfill batch dropped after 3 attempts: ${errorMessage(err)}`);
            return;
          }
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    };
    for (let t = start; t < end; t += 1000) {
      batch.push(...this.traffic.generate(t, Math.min(end, t + 1000), 1));
      if (batch.length >= INGEST_BATCH) await send();
    }
    await send();
    this.lastTickMs = end;
    this.phase = prev === 'backfilling' ? 'running' : prev;
    this.message = null;
    this.log(`Backfill complete: ${written.toLocaleString('en-US')} lines`);
    return written;
  }

  private startLive(): void {
    this.phase = 'running';
    this.message = null;
    this.lastTickMs = this.now();
    this.noise.init();
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs ?? 1000));
    this.timers.push(setInterval(() => void this.checkFix(), this.opts.fixCheckMs ?? 5000));
    this.log(
      `Live traffic started (~${this.traffic.baselineRate.toFixed(1)} lines/sec across ${this.profiles.length} apps)`,
    );
  }

  /** One engine step: generate baseline + scenario lines, fire noise, flush. */
  tick(): void {
    const now = this.now();
    const from = this.lastTickMs;
    this.lastTickMs = now;
    if (this.phase !== 'running') return;
    const dt = Math.max(0, (now - from) / 1000);
    if (!this.paused && dt > 0) this.emit(this.traffic.generate(from, now, this.rateMultiplier));
    if (this.run) this.emit(this.run.tick(now, dt));
    if (!this.paused) this.noiseTask = this.noise.tick();
    void this.flush();
  }

  async checkFix(): Promise<void> {
    if (this.phase !== 'running' || !this.run?.active) return;
    await this.run.checkFix();
  }

  /** Queues entries; entries in the future wait until their timestamp. */
  emit(entries: LogEntryInput[]): void {
    if (entries.length === 0) return;
    const now = this.now();
    for (const e of entries) {
      if (Date.parse(e.timestamp) > now) this.delayed.push(e);
      else this.buffer.push(e);
    }
  }

  deploy(app: App, service: string, sha: string, durationSec: number): void {
    const { before, after } = this.estate.deploy(app, service, sha);
    this.emit(this.estate.rolloutLines(before, after, sha, this.now(), durationSec));
  }

  /** Sends everything due to the Logs API. Concurrent calls share the in-flight flush. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const now = this.now();
    if (this.delayed.length > 0) {
      const due = this.delayed.filter((e) => Date.parse(e.timestamp) <= now);
      if (due.length > 0) {
        this.delayed = this.delayed.filter((e) => Date.parse(e.timestamp) > now);
        this.buffer.push(...due);
      }
    }
    if (this.buffer.length === 0) return;
    const pending = this.buffer.sort(byTimestamp);
    this.buffer = [];
    for (let i = 0; i < pending.length; i += INGEST_BATCH) {
      const chunk = pending.slice(i, i + INGEST_BATCH);
      try {
        await this.opts.systems.logs.ingest({ entries: chunk });
        this.totalLines += chunk.length;
        this.flushHistory.push({ at: this.now(), n: chunk.length });
        this.lastFlushAt = new Date(this.now()).toISOString();
        this.lastIngestError = null;
      } catch (err) {
        this.ingestErrors++;
        if (this.lastIngestError !== errorMessage(err)) {
          this.log(`Ingest failed (will retry): ${errorMessage(err)}`);
        }
        this.lastIngestError = errorMessage(err);
        // Keep what did not make it, bounded.
        this.buffer = pending.slice(i).concat(this.buffer);
        if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
        return;
      }
    }
  }

  setTraffic(input: TrafficInput): TrafficStatus {
    if (input.paused !== undefined) this.paused = input.paused;
    if (input.rate_multiplier !== undefined) {
      if (!(input.rate_multiplier >= 0 && input.rate_multiplier <= 10)) {
        throw new HttpError(400, 'rate_multiplier must be between 0 and 10');
      }
      this.rateMultiplier = input.rate_multiplier;
    }
    this.log(`Traffic ${this.paused ? 'paused' : 'running'} at ${this.rateMultiplier}x`);
    return this.trafficStatus();
  }

  private trafficStatus(): TrafficStatus {
    const now = this.now();
    this.flushHistory = this.flushHistory.filter((h) => now - h.at <= RATE_WINDOW_MS);
    const window =
      Math.min(RATE_WINDOW_MS, Math.max(1000, now - Date.parse(this.startedAt))) / 1000;
    const recent = this.flushHistory.reduce((sum, h) => sum + h.n, 0);
    return {
      paused: this.paused,
      rate_multiplier: this.rateMultiplier,
      lines_per_sec: Math.round((recent / window) * 10) / 10,
      total_lines: this.totalLines,
      buffered: this.buffer.length + this.delayed.length,
      last_flush_at: this.lastFlushAt,
      ingest_errors: this.ingestErrors,
      noise_merges: this.noise.changes,
      background_alerts: this.noise.alerts,
    };
  }

  // -------------------------------------------------------------------------
  // Scenario runs
  // -------------------------------------------------------------------------

  async trigger(id: string, input: TriggerInput = {}): Promise<RunStatus> {
    if (this.phase !== 'running') {
      throw new HttpError(503, `Simulator is not ready (${this.phase.replace(/_/g, ' ')})`);
    }
    const scenario = this.opts.scenarios.find((s) => s.id === id);
    if (!scenario) throw new HttpError(404, `Unknown scenario: ${id}`);
    const speed = input.speed ?? 1;
    if (!(speed >= 0.1 && speed <= 100))
      throw new HttpError(400, 'speed must be between 0.1 and 100');
    if (this.run?.active) {
      if (!input.force) {
        throw new HttpError(
          409,
          `Scenario "${this.run.id}" is still ${this.run.phase}; stop it first or pass force`,
        );
      }
      this.run.stop(`Stopped: replaced by a forced trigger of "${id}"`);
    }
    const run = new ScenarioRun(scenario, speed, this.runDeps());
    this.run = run;
    this.log(`Triggering "${id}" at ${speed}x`);
    try {
      await run.start();
    } catch (err) {
      throw new HttpError(502, run.status().error ?? errorMessage(err));
    }
    return run.status();
  }

  stop(): RunStatus | null {
    this.run?.stop('Stopped by operator');
    return this.run?.status() ?? null;
  }

  /** The active run (or last one). Exposed for tests. */
  get currentRun(): ScenarioRun | null {
    return this.run;
  }

  /** Stops the run, resets all four systems, clears state, backfills and restarts traffic. */
  reset(): Promise<ResetResponse> {
    if (this.resetting) return this.resetting;
    if (this.phase !== 'running') {
      throw new HttpError(503, `Simulator is not ready (${this.phase.replace(/_/g, ' ')})`);
    }
    this.resetting = this.doReset().finally(() => {
      this.resetting = null;
    });
    return this.resetting;
  }

  private async doReset(): Promise<ResetResponse> {
    const started = this.now();
    this.phase = 'resetting';
    this.message = 'Resetting systems';
    this.log('Reset: stopping run and resetting all systems');
    this.run?.stop('Stopped: systems reset');
    // Let in-flight writes land before the systems are wiped.
    await Promise.allSettled([this.flushing, this.noiseTask, this.run?.settle()]);
    const systems = await Promise.all(
      SYSTEMS.map(async (name: SystemName) => {
        try {
          await this.opts.systems[name].reset();
          return { name, ok: true, error: null };
        } catch (err) {
          this.log(`Reset of ${name} failed: ${errorMessage(err)}`);
          return { name, ok: false, error: errorMessage(err) };
        }
      }),
    );
    this.run = null;
    this.buffer = [];
    this.delayed = [];
    this.flushHistory = [];
    this.totalLines = 0;
    this.ingestErrors = 0;
    this.lastIngestError = null;
    this.estate = new Estate();
    this.traffic = new TrafficGenerator(this.estate, this.profiles);
    this.noise = this.createNoise();
    let backfilled = 0;
    try {
      backfilled = await this.backfill();
    } finally {
      this.phase = 'running';
      this.message = null;
      this.lastTickMs = this.now();
      this.noise.init();
    }
    const result: ResetResponse = {
      ok: systems.every((s) => s.ok),
      reset_at: new Date(this.now()).toISOString(),
      duration_ms: this.now() - started,
      systems,
      backfilled_lines: backfilled,
    };
    this.log(`Reset complete in ${result.duration_ms} ms`);
    return result;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  status(): SimulatorStatus {
    const empty = (url: string): EndpointHealth => ({
      url,
      ok: false,
      latency_ms: null,
      error: 'not checked yet',
      stats: null,
      checked_at: null,
    });
    const systems: SystemStatus[] = SYSTEMS.map((name) => {
      const s = this.opts.config.systems[name];
      return {
        name,
        label: s.label,
        ui_url: s.web,
        api: this.health.get(`${name}:api`) ?? empty(`${s.api}/health`),
        mcp: this.health.get(`${name}:mcp`) ?? empty(s.mcpHealth),
      };
    });
    return {
      engine: { phase: this.phase, started_at: this.startedAt, message: this.message },
      run: this.run?.status() ?? null,
      traffic: this.trafficStatus(),
      systems,
    };
  }

  /** Stops timers (tests, shutdown). */
  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

function byTimestamp(a: LogEntryInput, b: LogEntryInput): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}
