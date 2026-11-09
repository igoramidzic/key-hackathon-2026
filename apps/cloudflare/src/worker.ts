import { DurableObject } from 'cloudflare:workers';
import { createEstate, type Estate, isEstatePath, uiPrefixFor } from './estate';

export interface Env {
  WORLD: DurableObjectNamespace<SimWorld>;
  ASSETS: Fetcher;
  /** Optional fixed public origin (defaults to the request's origin). */
  PUBLIC_URL?: string;
  LOGS_CAPACITY?: string;
  BACKFILL_MINUTES?: string;
  GITLAB_HISTORY_SCALE?: string;
  GITLAB_MAX_CACHED_REPOS?: string;
  TRAFFIC_RATE?: string;
  /** Minutes without requests before the world winds down (it rebuilds from the seed on the next visit). */
  IDLE_MINUTES?: string;
}

const HEARTBEAT_MS = 5_000;

/**
 * One Durable Object holds the entire simulated estate in memory: all four systems, their MCP
 * servers and the simulator engine. A single instance gives one consistent world that every
 * client (UIs, agent MCP sessions, the log stream) sees.
 *
 * The simulator runs on timers, which only fire while the object is in memory, so an alarm
 * heartbeat keeps it resident while it's in use. After IDLE_MINUTES without requests the world
 * shuts down; the next request rebuilds it from the seed (same as `Reset`).
 */
export class SimWorld extends DurableObject<Env> {
  private estate: Estate | null = null;
  private lastRequestAt = 0;

  override async fetch(req: Request): Promise<Response> {
    this.lastRequestAt = Date.now();
    if (!this.estate) {
      const estate = createEstate({
        origin: this.env.PUBLIC_URL || new URL(req.url).origin,
        logsCapacity: Number(this.env.LOGS_CAPACITY ?? 15_000),
        backfillMinutes: Number(this.env.BACKFILL_MINUTES ?? 8),
        gitlabHistoryScale: Number(this.env.GITLAB_HISTORY_SCALE ?? 0.3),
        gitlabMaxMaterializedRepos: Number(this.env.GITLAB_MAX_CACHED_REPOS ?? 40),
        trafficRate: Number(this.env.TRAFFIC_RATE ?? 0.75),
      });
      this.estate = estate;
      estate.boot().catch((err) => console.error('[sim] boot failed', err));
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    }
    return this.estate.handle(req);
  }

  override async alarm(): Promise<void> {
    const idleMs = Number(this.env.IDLE_MINUTES ?? 30) * 60_000;
    if (!this.estate) return;
    if (Date.now() - this.lastRequestAt > idleMs) {
      console.log('[sim] idle, shutting the world down');
      this.estate.shutdown();
      this.estate = null;
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (isEstatePath(url.pathname)) {
      return env.WORLD.get(env.WORLD.idFromName('world')).fetch(req);
    }
    // Static UI. Deep links (e.g. /gitlab/keybank/PAY00/payments-api/-/merge_requests/3) fall
    // back to that UI's index.html so its client-side router can take over.
    const asset = await env.ASSETS.fetch(req);
    if (asset.status !== 404 || req.method !== 'GET') return asset;
    return env.ASSETS.fetch(new Request(new URL(`${uiPrefixFor(url.pathname)}/`, url), req));
  },
} satisfies ExportedHandler<Env>;
