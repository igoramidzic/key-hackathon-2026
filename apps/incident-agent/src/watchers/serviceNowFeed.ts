/**
 * Watches the ServiceNow activity feed (`/api/activity/tail`, long-poll) for:
 *  - incidents opened by people (phone, email, chat): bankers calling the service desk become
 *    human Signals. Anything opened by the agent itself (svc_incident_auto) is ignored.
 *  - updates, comments and work notes on incidents a case owns, written by someone else: humans
 *    changing state or adding comments, forwarded to the orchestrator.
 * Starts live (no replay of seeded history). A changed `epoch` means the world was reset.
 */
import type { ActivityEvent, ActivityTailResult, Incident } from '@sim/contracts/servicenow';
import type { HumanSignal } from '../cases/types';
import type { Logger } from '../log';
import type { Mcp } from '../mcp/gateway';
import { backoffMs, errorMessage, sleep } from '../util';

export const HUMAN_CONTACT_TYPES = ['phone', 'email', 'chat'];

export interface FeedEvents {
  onHuman(signal: HumanSignal): void;
  onIncidentEvent(event: ActivityEvent): void;
  onReset(): void;
  /** True when a case owns this incident (as parent or child). */
  owns(number: string): boolean;
}

export type TailFn = (params: Record<string, string>) => Promise<ActivityTailResult>;

export function httpTail(baseUrl: string): TailFn {
  return async (params) => {
    const res = await fetch(`${baseUrl}/api/activity/tail?${new URLSearchParams(params)}`, {
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`activity tail → HTTP ${res.status}`);
    return (await res.json()) as ActivityTailResult;
  };
}

export class ServiceNowFeed {
  epoch: number | undefined;
  cursor: number | undefined;
  private readonly locations = new Map<string, string | null>();

  constructor(
    private readonly tail: TailFn,
    private readonly mcp: Mcp,
    private readonly identity: string,
    private readonly log: Logger,
    private readonly events: FeedEvents,
  ) {}

  /** Positions the cursor at the live head. */
  async start(): Promise<void> {
    const head = await this.tail({ limit: '1' });
    this.cursor = head.last_seq;
    this.epoch = head.epoch;
  }

  /** One long-poll round. Returns the number of events handled. */
  async poll(waitSeconds = 25): Promise<number> {
    if (this.cursor === undefined) await this.start();
    const r = await this.tail({
      table: 'incident',
      after_seq: String(this.cursor),
      wait_seconds: String(waitSeconds),
      limit: '200',
    });
    if (this.epoch !== undefined && r.epoch !== this.epoch) {
      this.log.warn('ServiceNow feed: epoch changed (world reset)');
      this.epoch = r.epoch;
      this.cursor = r.last_seq;
      this.locations.clear();
      this.events.onReset();
      return 0;
    }
    this.epoch = r.epoch;
    for (const ev of r.items) await this.handle(ev);
    this.cursor = r.cursor;
    return r.items.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.poll();
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        this.log.warn(`ServiceNow feed: ${errorMessage(err)}`);
        await sleep(backoffMs(Math.min(failures, 5), 1_000, 20_000), signal);
      }
    }
  }

  async handle(ev: ActivityEvent): Promise<void> {
    const author = ev.entry.author?.username;
    if (author === this.identity) return;
    if (ev.kind === 'incident.opened') {
      const contact = ev.incident?.contact_type;
      if (!contact || !HUMAN_CONTACT_TYPES.includes(contact)) return;
      if (ev.incident?.caller?.username === this.identity) return;
      this.events.onHuman(await this.humanSignal(ev));
      return;
    }
    if (this.events.owns(ev.number)) this.events.onIncidentEvent(ev);
  }

  private async location(username: string | undefined): Promise<string | null> {
    if (!username) return null;
    if (this.locations.has(username)) return this.locations.get(username) ?? null;
    try {
      const user = await this.mcp.call<{ location?: string }>(
        'get_user',
        { username },
        { quiet: true },
      );
      this.locations.set(username, user.location ?? null);
      return user.location ?? null;
    } catch {
      this.locations.set(username, null);
      return null;
    }
  }

  private async humanSignal(ev: ActivityEvent): Promise<HumanSignal> {
    const summary = ev.incident!;
    let description = '';
    try {
      const full = await this.mcp.call<Incident>(
        'get_incident',
        { number: ev.number },
        { quiet: true },
      );
      description = full.description ?? '';
    } catch (err) {
      this.log.debug(`get_incident ${ev.number}: ${errorMessage(err)}`);
    }
    const caller = summary.caller?.username ?? null;
    return {
      source: 'human',
      id: `human-${ev.number}`,
      at: ev.at,
      incident_number: ev.number,
      short_description: summary.short_description,
      description,
      caller,
      location: await this.location(caller ?? undefined),
      contact_type: summary.contact_type,
      app_tla: summary.app?.tla ?? ev.app_tla ?? null,
      impact: summary.impact ?? null,
      urgency: summary.urgency ?? null,
      web_url: summary.web_url,
    };
  }
}
