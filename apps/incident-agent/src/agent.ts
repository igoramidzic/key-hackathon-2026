/**
 * Wires the agent together: MCP gateway, case store, dependency graph, correlator, watchers,
 * phase runner and the orchestrator with its step functions.
 */
import { Orchestrator } from './cases/orchestrator';
import { CaseStore } from './cases/store';
import type { Case, Signal } from './cases/types';
import type { AgentConfig } from './config';
import { Correlator } from './correlate/correlator';
import { GraphCache } from './correlate/graph';
import { type FlowDeps, flowSteps, reportFailure } from './flow/steps';
import { type Logger, logger } from './log';
import { McpGateway } from './mcp/gateway';
import { ClaudeProvider } from './phases/claude';
import { PhaseRunner } from './phases/runner';
import { startTimelineServer, type TimelineServer } from './timeline/server';
import { errorMessage, short } from './util';
import { AlertPoller } from './watchers/alerts';
import { LogWatcher } from './watchers/logWatcher';
import { httpTail, ServiceNowFeed } from './watchers/serviceNowFeed';

export class Agent {
  readonly log: Logger = logger('agent');
  readonly mcp: McpGateway;
  readonly store: CaseStore;
  readonly graphs: GraphCache;
  readonly correlator: Correlator;
  readonly orchestrator: Orchestrator;
  readonly runner: PhaseRunner | null;
  readonly deps: FlowDeps;
  private feed: ServiceNowFeed | undefined;

  constructor(readonly config: AgentConfig) {
    this.store = new CaseStore(config.dataDir);
    this.mcp = new McpGateway({
      urls: config.mcp,
      dryRun: config.dryRun,
      onDryRun: (tool, args) => logger('dry-run').info(`${tool} ${short(args, 300)}`),
      onCall: (rec) => {
        if (!rec.caseId) return;
        const c = this.store.get(rec.caseId);
        if (!c) return;
        this.store.event(
          c,
          'tool',
          `${rec.tool}${rec.dryRun ? ' (dry run)' : ''} ${rec.ok ? 'ok' : `failed: ${rec.error}`} ${rec.ms}ms`,
          { data: { server: rec.server, args: rec.args, attempts: rec.attempts } },
        );
      },
    });
    this.graphs = new GraphCache(this.mcp, logger('graph'));
    this.runner =
      config.llm.mode === 'claude'
        ? new PhaseRunner({
            provider: new ClaudeProvider(config.mcp),
            dataDir: config.dataDir,
            model: config.llm.model,
            deepModel: config.llm.deepModel,
          })
        : null;

    const orchestratorRef: { current?: Orchestrator } = {};
    this.correlator = new Correlator({
      store: this.store,
      graph: () => this.graphs.graph,
      config,
      log: logger('correlate'),
      mcp: this.mcp,
      epoch: () => this.feed?.epoch ?? null,
      onNewCase: (c) => orchestratorRef.current?.track(c),
      onCaseChanged: (c) => orchestratorRef.current?.poke(c.id),
    });
    this.deps = {
      config,
      mcp: this.mcp,
      store: this.store,
      graph: () => this.graphs.graph,
      runner: this.runner,
      correlator: this.correlator,
      log: logger('flow'),
    };
    this.orchestrator = new Orchestrator({
      store: this.store,
      log: logger('orchestr'),
      steps: flowSteps(this.deps),
      idleMs: Math.max(2_000, 5_000 / config.speed),
      onFailed: (c, reason) => reportFailure(this.deps, c, reason),
    });
    orchestratorRef.current = this.orchestrator;
    this.deps.orchestrator = this.orchestrator;
  }

  /** Handles a signal from any watcher. */
  async signal(signal: Signal): Promise<void> {
    const decision = await this.correlator.ingest(signal);
    this.log.debug(`${signal.id} → ${JSON.stringify(decision).slice(0, 200)}`);
  }

  private worldReset(source: string): void {
    const archived = this.orchestrator.archiveAll(`world reset (${source})`);
    this.correlator.worldReset();
    if (archived.length)
      this.log.warn(`world reset (${source}): archived ${archived.length} case(s)`);
  }

  owns(number: string): Case | undefined {
    return this.store
      .open()
      .find((c) => c.incident?.number === number || c.children.includes(number));
  }

  async run(signal: AbortSignal): Promise<void> {
    const resumed = this.store
      .load()
      .filter((c) => !['resolved', 'failed', 'abandoned'].includes(c.phase));
    await this.graphs.load();
    this.graphs.startRefresh();
    this.orchestrator.start();
    // #27: the live case timeline for the demo.
    let timeline: TimelineServer | undefined;
    try {
      timeline = await startTimelineServer(this.store, {
        port: this.config.timelinePort,
        log: logger('timeline'),
        web: this.config.web,
        info: {
          speed: this.config.speed,
          llm: this.config.llm.mode,
          auto_resolve: this.config.autoResolve,
          dry_run: this.config.dryRun,
        },
      });
      this.log.info(`live timeline at ${timeline.url}`);
    } catch (err) {
      this.log.warn(
        `live timeline not started on :${this.config.timelinePort}: ${errorMessage(err)}`,
      );
    }
    if (resumed.length) this.log.info(`resumed ${resumed.length} open case(s)`);

    const logs = new LogWatcher(this.config, logger('logs'), {
      onSignal: (s) => void this.signal(s),
      onReset: () => this.worldReset('log stream'),
    });
    this.feed = new ServiceNowFeed(
      httpTail(this.config.serviceNowApi),
      this.mcp,
      this.config.identity,
      logger('snow'),
      {
        onHuman: (s) => void this.signal(s),
        onIncidentEvent: (ev) => {
          const c = this.owns(ev.number);
          if (!c) return;
          this.store.event(
            c,
            'note',
            `${ev.entry.author?.name ?? 'someone'} on ${ev.number}: ${ev.kind.replace('incident.', '')} ${short(ev.entry.text, 160)}`,
            { data: { kind: ev.kind, changes: ev.entry.changes ?? [] } },
          );
          this.orchestrator.poke(c.id);
        },
        onReset: () => this.worldReset('ServiceNow epoch'),
        owns: (n) => Boolean(this.owns(n)),
      },
    );
    await this.feed.start();
    const alerts = new AlertPoller(this.mcp, logger('alerts'), (s) => void this.signal(s));

    this.log.info(
      `running (llm: ${this.config.llm.mode}${this.config.dryRun ? ', DRY RUN' : ''}${this.config.autoResolve ? ', auto-resolve' : ''})`,
    );
    const watchers = [
      logs.run(signal),
      this.feed.run(signal),
      alerts.run(signal, Math.max(3_000, 10_000 / this.config.speed)),
    ].map((p) => p.catch((err) => this.log.error(`watcher stopped: ${errorMessage(err)}`)));
    await Promise.all(watchers);
    this.graphs.stop();
    await this.orchestrator.stop();
    await timeline?.close();
    await this.mcp.close();
  }
}
