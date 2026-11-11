/**
 * Polls Moogsoft (`list_alerts`, open, recently active) through MCP and emits a Signal for every
 * alert not seen before. Alerts that were already open and quiet when the agent started are
 * treated as known background, not new trouble.
 */
import type { Alert, AlertSeverity } from '@sim/contracts/logs';
import type { AlertSignal } from '../cases/types';
import type { Logger } from '../log';
import type { Mcp } from '../mcp/gateway';
import { errorMessage, sleep } from '../util';

type AlertItem = Pick<
  Alert,
  | 'id'
  | 'severity'
  | 'status'
  | 'description'
  | 'app_tla'
  | 'service'
  | 'first_event_time'
  | 'web_url'
>;

export const ALERT_RANK: Record<AlertSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  warning: 1,
  clear: 0,
};

export class AlertPoller {
  private readonly seen = new Set<number>();
  private primed = false;

  constructor(
    private readonly mcp: Mcp,
    private readonly log: Logger,
    private readonly onSignal: (signal: AlertSignal) => void,
    /** Alerts first raised within this window at start-up still count as new. */
    private readonly freshSec = 120,
  ) {}

  private async list(since: string): Promise<AlertItem[]> {
    const out = await this.mcp.call<{ items: AlertItem[] }>(
      'list_alerts',
      { status: ['open'], since, limit: 100 },
      { quiet: true },
    );
    return out.items ?? [];
  }

  /** Marks alerts that were already open (and not fresh) as known. */
  async prime(now = Date.now()): Promise<void> {
    const open = await this.list('24h');
    for (const a of open) {
      if (now - Date.parse(a.first_event_time) > this.freshSec * 1000) this.seen.add(a.id);
    }
    this.primed = true;
  }

  reset(): void {
    this.seen.clear();
    this.primed = false;
  }

  async poll(): Promise<AlertSignal[]> {
    if (!this.primed) await this.prime();
    const out: AlertSignal[] = [];
    for (const a of await this.list('5m')) {
      if (this.seen.has(a.id)) continue;
      this.seen.add(a.id);
      const signal: AlertSignal = {
        source: 'alert',
        id: `alert-${a.id}`,
        at: a.first_event_time,
        alert_id: a.id,
        app_tla: a.app_tla,
        service: a.service,
        severity: a.severity,
        description: a.description,
        web_url: a.web_url,
      };
      out.push(signal);
      this.onSignal(signal);
    }
    return out;
  }

  async run(signal: AbortSignal, intervalMs = 10_000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.poll();
      } catch (err) {
        this.log.warn(`alert poll failed: ${errorMessage(err)}`);
      }
      await sleep(intervalMs, signal);
    }
  }
}
