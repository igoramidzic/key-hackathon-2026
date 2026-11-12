/**
 * Signals → cases. Decides, with evidence it can explain, which failing apps are one incident.
 *
 * - Strong log signal for an app already in an open case → attach.
 * - Otherwise score it against every open case (evidence.ts): ≥ join → join; ≥ tentative → join
 *   as tentative (triage confirms or splits it before anything is created); below → new pending
 *   case with a settle window, so the rest of a cascade can arrive before triage.
 * - Apps failing after a case is declared still join it (one incident, one channel).
 * - Weak (WARNING-only) signals and alerts never open a case; they attach to a related case or
 *   wait in a short buffer for one.
 * - Human signals attach to an open case as candidate children; with no case, ≥2 calls in the
 *   window (or one with impact/urgency 1) open a human-reported case.
 * - A recently resolved case suppresses new cases for its apps (cooldown).
 * Every decision is stored on the case (relations, timeline) with its reasons.
 */
import type { CaseStore } from '../cases/store';
import type { AlertSignal, Case, HumanSignal, LogSignal, Signal } from '../cases/types';
import type { AgentConfig } from '../config';
import type { Logger } from '../log';
import type { Mcp } from '../mcp/gateway';
import { addMs, errorMessage, isoNow } from '../util';
import { type Evidence, mentionedApps, profile, scoreSignal } from './evidence';
import type { DependencyGraph } from './graph';

export interface CorrelatorDeps {
  store: CaseStore;
  graph: () => DependencyGraph;
  config: Pick<AgentConfig, 'correlate' | 'speed'>;
  log: Logger;
  /** For trace lookups (optional). */
  mcp?: Mcp;
  epoch?: () => number | null;
  onNewCase(c: Case): void;
  onCaseChanged(c: Case, change: { newApps: string[]; signal: Signal }): void;
  now?: () => number;
}

export type Decision =
  | { action: 'join'; caseId: string; tentative: boolean; evidence: Evidence }
  | { action: 'attach'; caseId: string }
  | { action: 'new'; caseId: string }
  | { action: 'buffer' | 'suppress' | 'ignore'; reason: string };

const ACTIVE_FOR_JOIN = (c: Case) => !['resolved', 'failed', 'abandoned'].includes(c.phase);

export class Correlator {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly weak: LogSignal[] = [];
  private readonly alerts: AlertSignal[] = [];
  private readonly humans: HumanSignal[] = [];
  private readonly traceCache = new Map<string, string[]>();

  constructor(private readonly deps: CorrelatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Serialised: two signals never race to open two cases. */
  ingest(signal: Signal): Promise<Decision> {
    const next = this.queue.then(() => this.decide(signal));
    this.queue = next.catch(() => {});
    return next;
  }

  private open(): Case[] {
    return this.deps.store.open().filter(ACTIVE_FOR_JOIN);
  }

  private async decide(signal: Signal): Promise<Decision> {
    try {
      if (signal.source === 'human') return this.human(signal);
      if (signal.source === 'alert') return this.alert(signal);
      return await this.logSignal(signal);
    } catch (err) {
      this.deps.log.warn(`correlate ${signal.id}: ${errorMessage(err)}`);
      return { action: 'ignore', reason: errorMessage(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Log signals
  // ---------------------------------------------------------------------------

  private windowMs(): number {
    return Math.max(120_000, (10 * 60_000) / this.deps.config.speed);
  }

  /** When the world was last reset: what was resolved before that says nothing about it now. */
  private resetAt = 0;

  /** The world was reset (seeded baseline restored): drop the cool-down from earlier cases. */
  worldReset(at = this.now()): void {
    this.resetAt = at;
  }

  private inCooldown(app: string): Case | undefined {
    const cooldown = this.deps.config.correlate.cooldownMin * 60_000;
    return this.deps.store.all().find((c) => {
      if (c.phase !== 'resolved' || !c.apps.includes(app)) return false;
      const resolved = Date.parse(c.milestones.resolved ?? c.updated_at);
      return resolved > this.resetAt && this.now() - resolved < cooldown;
    });
  }

  private async traceApps(signal: LogSignal): Promise<Set<string> | undefined> {
    const mcp = this.deps.mcp;
    if (!mcp || signal.traces.length === 0) return undefined;
    const out = new Set<string>();
    for (const trace of signal.traces.slice(0, 3)) {
      let apps = this.traceCache.get(trace);
      if (!apps) {
        try {
          const res = await mcp.call<{
            items: { labels?: { app_tla?: string }; app_tla?: string }[];
          }>(
            'search_logs',
            { filter: `trace="${trace}"`, start_time: '30m', limit: 50 },
            { quiet: true },
          );
          apps = [
            ...new Set(
              res.items
                .map((e) => e.labels?.app_tla ?? e.app_tla)
                .filter((t): t is string => Boolean(t)),
            ),
          ];
        } catch {
          apps = [];
        }
        this.traceCache.set(trace, apps);
      }
      for (const a of apps) out.add(a);
    }
    return out;
  }

  /** Best case for a log signal, with evidence. */
  async bestCase(signal: LogSignal): Promise<{ c: Case; evidence: Evidence } | undefined> {
    const graph = this.deps.graph();
    const opts = { windowMs: this.windowMs() };
    let best: { c: Case; evidence: Evidence } | undefined;
    for (const c of this.open()) {
      let evidence = scoreSignal(signal, profile(c, graph), graph, opts);
      const { join } = this.deps.config.correlate;
      if (evidence.score < join && evidence.score + 0.5 >= join) {
        const traceApps = await this.traceApps(signal);
        if (traceApps?.size)
          evidence = scoreSignal(signal, profile(c, graph), graph, { ...opts, traceApps });
      }
      if (!best || evidence.score > best.evidence.score) best = { c, evidence };
    }
    return best;
  }

  private async logSignal(signal: LogSignal): Promise<Decision> {
    const { join, tentative } = this.deps.config.correlate;
    const existing = this.open().find((c) => c.apps.includes(signal.app_tla));
    if (existing) {
      this.attach(existing, signal, `${signal.reason} on ${signal.app_tla}/${signal.service}`);
      return { action: 'attach', caseId: existing.id };
    }
    const best = await this.bestCase(signal);
    if (signal.strength === 'weak') {
      if (best && best.evidence.score >= tentative) {
        this.attach(
          best.c,
          signal,
          `weak ${signal.reason} on ${signal.app_tla} (related: ${best.evidence.reasons.join('; ')})`,
        );
        return { action: 'attach', caseId: best.c.id };
      }
      // Weak signals support a human-reported case that may open soon.
      const human = this.open().find((c) => c.kind === 'human-reported');
      if (human) {
        this.attach(
          human,
          signal,
          `weak ${signal.reason} on ${signal.app_tla} during the reported problem`,
        );
        return { action: 'attach', caseId: human.id };
      }
      this.remember(this.weak, signal);
      return { action: 'buffer', reason: 'weak signals never open a case' };
    }

    if (best && best.evidence.score >= tentative) {
      const isTentative = best.evidence.score < join;
      this.join(best.c, signal, best.evidence, isTentative);
      return { action: 'join', caseId: best.c.id, tentative: isTentative, evidence: best.evidence };
    }

    const cooling = this.inCooldown(signal.app_tla);
    if (cooling) {
      this.deps.log.info(`suppressed ${signal.app_tla}: resolved recently in ${cooling.id}`);
      return { action: 'suppress', reason: `recently resolved in ${cooling.id}` };
    }

    const c = this.deps.store.create({
      kind: 'monitoring',
      apps: [signal.app_tla],
      onset_at: signal.first_seen,
      settle_until: addMs(isoNow(), this.deps.config.correlate.settleSec * 1000),
      epoch: this.deps.epoch?.() ?? null,
      signals: [signal],
      relations: [{ tla: signal.app_tla, score: 1, reasons: ['first signal'], tentative: false }],
    });
    this.recompute(c);
    this.adoptBuffered(c);
    this.deps.store.event(
      c,
      'signal',
      `${signal.reason} on ${signal.app_tla}/${signal.service}: ${signal.count} errors, ${signal.rate}/min ` +
        `(baseline ${signal.baseline}) ${signal.error_types.slice(0, 2).join(', ')}`,
      { data: { signal: signal.id, filter: signal.filter } },
    );
    this.deps.log.info(`new case ${c.id} for ${signal.app_tla} (${signal.reason})`);
    this.deps.onNewCase(c);
    return { action: 'new', caseId: c.id };
  }

  private join(c: Case, signal: LogSignal, evidence: Evidence, tentative: boolean): void {
    c.apps.push(signal.app_tla);
    c.signals.push(signal);
    c.relations.push({
      tla: signal.app_tla,
      score: evidence.score,
      reasons: evidence.reasons,
      tentative,
    });
    const firstSeen = Date.parse(signal.first_seen);
    if (!c.onset_at || firstSeen < Date.parse(c.onset_at)) c.onset_at = signal.first_seen;
    this.recompute(c);
    this.adoptBuffered(c);
    this.deps.store.event(
      c,
      'decision',
      `${signal.app_tla} joins the case${tentative ? ' (tentative)' : ''}, score ${evidence.score}: ${evidence.reasons.join('; ')}`,
      { data: { tla: signal.app_tla, score: evidence.score, tentative } },
    );
    this.deps.log.info(
      `${signal.app_tla} → ${c.id}${tentative ? ' (tentative)' : ''} score ${evidence.score}`,
    );
    this.deps.onCaseChanged(c, { newApps: [signal.app_tla], signal });
  }

  private attach(c: Case, signal: Signal, text: string): void {
    if (!c.signals.some((s) => s.id === signal.id)) c.signals.push(signal);
    this.deps.store.event(c, 'signal', text, { data: { signal: signal.id } });
    this.deps.onCaseChanged(c, { newApps: [], signal });
  }

  /** Upstream candidates for the case's failing apps, recomputed whenever an app joins. */
  recompute(c: Case): void {
    c.upstream_candidates = this.deps.graph().commonUpstream(c.apps);
  }

  private remember<T extends Signal>(buffer: T[], signal: T): void {
    buffer.push(signal);
    const horizon = this.now() - 15 * 60_000;
    while (buffer.length && Date.parse(buffer[0]!.at) < horizon) buffer.shift();
  }

  /** Attaches buffered alerts and weak signals for the case's apps. */
  private adoptBuffered(c: Case): void {
    const graph = this.deps.graph();
    const related = (tla: string) =>
      c.apps.includes(tla) || c.apps.some((a) => graph.direct(a, tla));
    for (const buffer of [this.alerts, this.weak] as Signal[][]) {
      for (let i = buffer.length - 1; i >= 0; i--) {
        const s = buffer[i]!;
        const tla = s.source === 'human' ? s.app_tla : s.app_tla;
        const fits =
          s.source === 'alert'
            ? Boolean(tla && c.apps.includes(tla))
            : Boolean(tla && related(tla));
        if (fits) {
          if (!c.signals.some((x) => x.id === s.id)) c.signals.push(s);
          buffer.splice(i, 1);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------

  private alert(signal: AlertSignal): Decision {
    // Only for an app that is part of a case: background alerts on neighbouring apps never stop,
    // so an alert on a related app waits until that app itself starts failing.
    const target = this.open().find((c) => c.apps.includes(signal.app_tla));
    if (target) {
      this.attach(
        target,
        signal,
        `alert ${signal.alert_id} (${signal.severity}) on ${signal.app_tla}: ${signal.description}`,
      );
      return { action: 'attach', caseId: target.id };
    }
    this.remember(this.alerts, signal);
    return { action: 'buffer', reason: 'alerts never open a case on their own' };
  }

  // ---------------------------------------------------------------------------
  // Human signals
  // ---------------------------------------------------------------------------

  private humanTarget(signal: HumanSignal): Case | undefined {
    const graph = this.deps.graph();
    const windowMs = this.deps.config.correlate.humanWindowMin * 60_000;
    const at = Date.parse(signal.at);
    const open = this.open().filter((c) => {
      const onset = Date.parse(c.onset_at ?? c.opened_at);
      return at >= onset - windowMs;
    });
    if (open.length === 0) return undefined;
    const named = mentionedApps([signal.short_description, signal.description], graph);
    const byName = (c: Case) => {
      const names = c.apps.map((a) => graph.name(a).toLowerCase());
      const text = `${signal.short_description} ${signal.description}`.toLowerCase();
      return names.some((n) =>
        n
          .split(/\s+/)
          .filter((w) => w.length > 4)
          .some((w) => text.includes(w)),
      );
    };
    return (
      open.find((c) => signal.app_tla && c.apps.includes(signal.app_tla)) ??
      open.find((c) => c.apps.some((a) => named.has(a))) ??
      open.find(byName) ??
      open.sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0]
    );
  }

  private human(signal: HumanSignal): Decision {
    const target = this.humanTarget(signal);
    if (target) {
      this.attach(
        target,
        signal,
        `${signal.contact_type} from ${signal.caller ?? 'unknown'}${signal.location ? ` (${signal.location})` : ''}: ${signal.incident_number} "${signal.short_description}" — candidate child`,
      );
      return { action: 'attach', caseId: target.id };
    }
    this.remember(this.humans, signal);
    const windowMs = this.deps.config.correlate.humanWindowMin * 60_000;
    const recent = this.humans.filter((h) => Date.parse(signal.at) - Date.parse(h.at) <= windowMs);
    const urgent = signal.impact === 1 && signal.urgency === 1;
    if (recent.length < 2 && !urgent)
      return { action: 'buffer', reason: 'waiting for a second call' };

    const apps = [...new Set(recent.map((h) => h.app_tla).filter((t): t is string => Boolean(t)))];
    const weak = this.weak.filter((w) => Date.parse(w.at) >= Date.parse(recent[0]!.at) - windowMs);
    const c = this.deps.store.create({
      kind: 'human-reported',
      apps,
      onset_at: recent[0]!.at,
      settle_until: addMs(isoNow(), this.deps.config.correlate.settleSec * 1000),
      epoch: this.deps.epoch?.() ?? null,
      signals: [...recent, ...weak],
      relations: apps.map((tla) => ({
        tla,
        score: 1,
        reasons: ['named on a call'],
        tentative: false,
      })),
    });
    for (const h of recent) this.humans.splice(this.humans.indexOf(h), 1);
    for (const w of weak) this.weak.splice(this.weak.indexOf(w), 1);
    if (apps.length) this.recompute(c);
    this.deps.store.event(
      c,
      'signal',
      `${recent.length} calls in ${Math.round((Date.parse(signal.at) - Date.parse(recent[0]!.at)) / 60_000)} min: ` +
        recent.map((h) => `${h.incident_number} (${h.location ?? h.caller ?? '?'})`).join(', ') +
        (weak.length
          ? `; warnings rising on ${[...new Set(weak.map((w) => w.app_tla))].join(', ')}`
          : ''),
    );
    this.deps.log.info(`new human-reported case ${c.id} from ${recent.length} calls`);
    this.deps.onNewCase(c);
    return { action: 'new', caseId: c.id };
  }
}
