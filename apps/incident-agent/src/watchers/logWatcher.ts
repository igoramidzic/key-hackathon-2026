/**
 * Glue between the live log stream and the detector: learns the baseline from recent history,
 * follows the stream, emits Signals and reports world resets.
 */
import type { LogSignal } from '../cases/types';
import type { AgentConfig } from '../config';
import type { Logger } from '../log';
import { duration, errorMessage } from '../util';
import { SpikeDetector, toMini } from './detector';
import { LogStreamClient } from './logStream';

export interface LogWatcherEvents {
  onSignal(signal: LogSignal): void;
  onReset(): void;
}

export class LogWatcher {
  readonly detector: SpikeDetector;
  readonly client: LogStreamClient;
  private ticker: ReturnType<typeof setInterval> | undefined;
  entries = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly log: Logger,
    private readonly events: LogWatcherEvents,
  ) {
    this.detector = new SpikeDetector({ ...config.detect, cooldownSec: 600 / config.speed });
    this.client = new LogStreamClient(config.logsApi, log);
  }

  /** Primes the baseline from the last `baselineSec` of logs. */
  async learn(): Promise<number> {
    try {
      const history = await this.client.history(this.config.detect.baselineSec);
      this.detector.learn(history.map(toMini));
      return history.length;
    } catch (err) {
      this.log.warn(`baseline history unavailable, learning live: ${errorMessage(err)}`);
      return 0;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const learned = await this.learn();
    this.log.info(
      `log watcher: baseline from ${learned} entries (last ${this.config.detect.baselineSec}s), following live`,
    );
    this.ticker = setInterval(() => {
      for (const s of this.detector.tick(Date.now())) this.emit(s);
    }, 2_000);
    try {
      for await (const item of this.client.follow({ signal, afterSeq: this.client.lastSeq })) {
        if (item.type === 'reset') {
          this.log.warn('log stream: world reset');
          this.events.onReset();
          await this.learn();
          continue;
        }
        this.entries++;
        for (const s of this.detector.ingest(toMini(item.entry))) this.emit(s);
      }
    } finally {
      clearInterval(this.ticker);
    }
  }

  private emit(signal: LogSignal): void {
    const latency = Date.now() - Date.parse(signal.first_seen);
    this.log.info(
      `signal ${signal.reason} ${signal.app_tla}/${signal.service}: ${signal.count} in window, ` +
        `${signal.rate}/min (baseline ${signal.baseline}) ${signal.error_types.slice(0, 2).join(', ')} ` +
        `— detected ${duration(latency)} after first error`,
    );
    this.events.onSignal(signal);
  }
}
