/**
 * The CMDB dependency graph, cached in memory. Edge A→B means A calls B (B is upstream of A).
 * Loaded once over MCP (`search_apps` for every app, then `get_app_dependencies` direction "up")
 * and refreshed every ~10 minutes.
 */
import type { UpstreamCandidate } from '../cases/types';
import type { Logger } from '../log';
import type { Mcp } from '../mcp/gateway';
import { errorMessage, mapLimit } from '../util';

export interface AppNode {
  tla: string;
  name: string;
  tier: number;
  /** k8s container name in the logs, e.g. "online-banking-bff". */
  service: string | null;
  repos: string[];
  support_group: { id: string; name: string } | null;
  on_call: { primary: string | null; secondary: string | null } | null;
  web_url: string | null;
}

interface AppListItem {
  tla: string;
}

interface AppDetailLite {
  tla: string;
  name: string;
  tier: number;
  web_url?: string;
  upstream?: { tla: string }[];
  runtime?: { service?: string };
  repos?: string[];
  support_group?: {
    id: string;
    name: string;
    on_call?: { primary?: { username: string }; secondary?: { username: string } };
  } | null;
}

export class DependencyGraph {
  readonly nodes = new Map<string, AppNode>();
  /** tla → apps it calls (its upstreams). */
  readonly up = new Map<string, Set<string>>();
  /** tla → apps that call it (its downstreams). */
  readonly down = new Map<string, Set<string>>();
  loadedAt = 0;

  static fromEdges(nodes: AppNode[], edges: [string, string][]): DependencyGraph {
    const g = new DependencyGraph();
    for (const n of nodes) g.nodes.set(n.tla, n);
    for (const [from, to] of edges) g.addEdge(from, to);
    g.loadedAt = Date.now();
    return g;
  }

  addEdge(from: string, to: string): void {
    if (from === to) return;
    for (const tla of [from, to]) {
      if (!this.up.has(tla)) this.up.set(tla, new Set());
      if (!this.down.has(tla)) this.down.set(tla, new Set());
    }
    this.up.get(from)!.add(to);
    this.down.get(to)!.add(from);
  }

  get size(): number {
    return this.nodes.size;
  }

  name(tla: string): string {
    return this.nodes.get(tla)?.name ?? tla;
  }

  /** "CIF - Customer Information File" */
  label(tla: string): string {
    const n = this.nodes.get(tla);
    return n ? `${tla} - ${n.name}` : tla;
  }

  /** TLA of the app running `service` (k8s container name). */
  appOfService(service: string): string | undefined {
    if (!this.serviceIndex) {
      this.serviceIndex = new Map();
      for (const n of this.nodes.values()) if (n.service) this.serviceIndex.set(n.service, n.tla);
    }
    return this.serviceIndex.get(service);
  }
  private serviceIndex: Map<string, string> | undefined;

  private walk(tla: string, edges: Map<string, Set<string>>, depth: number): Map<string, number> {
    const seen = new Map<string, number>([[tla, 0]]);
    let frontier = [tla];
    for (let hop = 1; hop <= depth && frontier.length; hop++) {
      const next: string[] = [];
      for (const t of frontier) {
        for (const n of edges.get(t) ?? []) {
          if (seen.has(n)) continue;
          seen.set(n, hop);
          next.push(n);
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** Apps `tla` depends on (transitively) with their hop count; includes itself at 0. */
  upstreamOf(tla: string, depth = 3): Map<string, number> {
    return this.walk(tla, this.up, depth);
  }

  /** Apps that depend on `tla` (transitively) with their hop count; includes itself at 0. */
  downstreamOf(tla: string, depth = 3): Map<string, number> {
    return this.walk(tla, this.down, depth);
  }

  /** a calls b or b calls a. */
  direct(a: string, b: string): boolean {
    return Boolean(this.up.get(a)?.has(b) || this.up.get(b)?.has(a));
  }

  /**
   * Common upstream candidates for a set of failing apps: every app that is upstream of (or is)
   * at least two of them within `depth` hops (or the app itself when only one is failing),
   * ranked by how many failing apps it covers, then by how specific it is (the share of its
   * downstream that is failing; a hub everyone calls is weak evidence), then by fewest hops.
   * Candidates that log no errors are included: in a cascade the culprit looks healthy.
   */
  commonUpstream(failing: string[], depth = 3, limit = 8): UpstreamCandidate[] {
    const apps = [...new Set(failing)];
    if (apps.length === 0) return [];
    const cover = new Map<string, { covers: number; hops: number }>();
    for (const app of apps) {
      for (const [tla, hops] of this.upstreamOf(app, depth)) {
        const c = cover.get(tla) ?? { covers: 0, hops: 0 };
        c.covers++;
        c.hops = Math.max(c.hops, hops);
        cover.set(tla, c);
      }
    }
    const failingSet = new Set(apps);
    const min = apps.length === 1 ? 1 : 2;
    const ranked = [...cover.entries()]
      .filter(([, c]) => c.covers >= min)
      .map(([tla, c]) => {
        const downstream = this.downstreamOf(tla, depth);
        const failingBelow = [...downstream.keys()].filter((t) => failingSet.has(t)).length;
        return {
          candidate: {
            tla,
            name: this.name(tla),
            covers: c.covers,
            of: apps.length,
            hops: c.hops,
            failing: failingSet.has(tla),
          } satisfies UpstreamCandidate,
          specificity: failingBelow / Math.max(1, downstream.size),
        };
      });
    ranked.sort(
      (a, b) =>
        b.candidate.covers - a.candidate.covers ||
        b.specificity - a.specificity ||
        a.candidate.hops - b.candidate.hops ||
        a.candidate.tla.localeCompare(b.candidate.tla),
    );
    return ranked.slice(0, limit).map((r) => r.candidate);
  }

  /** Shortest-hop shared upstream of a and b (within depth), or null. */
  sharedUpstream(a: string, b: string, depth = 3): { tla: string; hops: number } | null {
    const ua = this.upstreamOf(a, depth);
    const ub = this.upstreamOf(b, depth);
    let best: { tla: string; hops: number } | null = null;
    for (const [tla, ha] of ua) {
      const hb = ub.get(tla);
      if (hb === undefined) continue;
      const hops = Math.max(ha, hb);
      if (
        !best ||
        hops < best.hops ||
        (hops === best.hops && this.downstreamSize(tla) < this.downstreamSize(best.tla))
      )
        best = { tla, hops };
    }
    return best;
  }

  downstreamSize(tla: string, depth = 3): number {
    return this.downstreamOf(tla, depth).size - 1;
  }
}

/** Loads (and refreshes) the graph over MCP. */
export class GraphCache {
  graph = new DependencyGraph();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly mcp: Mcp,
    private readonly log: Logger,
  ) {}

  async load(): Promise<DependencyGraph> {
    const apps: AppListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.mcp.call<{ items: AppListItem[]; next_cursor: string | null }>(
        'search_apps',
        { limit: 100, ...(cursor ? { cursor } : {}) },
        { quiet: true },
      );
      apps.push(...res.items);
      if (!res.next_cursor) break;
      cursor = res.next_cursor;
    }
    const edges: [string, string][] = [];
    const nodes = await mapLimit(apps, 12, async (app): Promise<AppNode> => {
      const d = await this.mcp.call<AppDetailLite>('get_app', { tla: app.tla }, { quiet: true });
      for (const u of d.upstream ?? []) edges.push([d.tla, u.tla]);
      return {
        tla: d.tla,
        name: d.name,
        tier: d.tier,
        service: d.runtime?.service ?? null,
        repos: d.repos ?? [],
        support_group: d.support_group
          ? { id: d.support_group.id, name: d.support_group.name }
          : null,
        on_call: d.support_group?.on_call
          ? {
              primary: d.support_group.on_call.primary?.username ?? null,
              secondary: d.support_group.on_call.secondary?.username ?? null,
            }
          : null,
        web_url: d.web_url ?? null,
      };
    });
    const graph = DependencyGraph.fromEdges(nodes, edges);
    this.graph = graph;
    this.log.info(`dependency graph: ${graph.size} apps, ${edges.length} edges`);
    return graph;
  }

  startRefresh(everyMs = 10 * 60_000): void {
    this.timer = setInterval(() => {
      this.load().catch((err) => this.log.warn(`graph refresh failed: ${errorMessage(err)}`));
    }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
