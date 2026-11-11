/**
 * The incident flow: one step function per phase. Each step is idempotent: it can run again
 * after a crash or a retry without creating anything twice.
 */
import type { Orchestrator, StepFn } from '../cases/orchestrator';
import type { CaseStore } from '../cases/store';
import type { Case, Phase } from '../cases/types';
import type { AgentConfig } from '../config';
import type { Correlator } from '../correlate/correlator';
import type { DependencyGraph } from '../correlate/graph';
import type { Logger } from '../log';
import type { Mcp } from '../mcp/gateway';
import type { PhaseRunner } from '../phases/runner';
import { hhmm } from '../util';
import { splitOff } from './regroup';
import { triage } from './triage';

export interface FlowDeps {
  config: AgentConfig;
  mcp: Mcp;
  store: CaseStore;
  graph: () => DependencyGraph;
  runner: PhaseRunner | null;
  correlator?: Correlator;
  log: Logger;
  orchestrator?: Orchestrator;
}

/**
 * detected → triaged: wait out the settle window so the rest of a cascade can arrive, then
 * triage (#16). Apps triage finds unrelated are split into their own case before anything is
 * created, which is cheap because only signals move.
 */
export function detected(deps: FlowDeps): StepFn {
  return async (c, ctx) => {
    const until = c.settle_until ? Date.parse(c.settle_until) : 0;
    const left = until - Date.now();
    if (left > 0) return { wait: left };

    const started = Date.now();
    const { scope, source } = await triage(deps, c);
    if (c.kind === 'human-reported' && c.apps.length === 0) {
      // Nothing in the logs points at an app yet: look again shortly, then go on regardless.
      const tries = (c.attempts.discover ?? 0) + 1;
      c.attempts.discover = tries;
      if (tries < 4) {
        deps.store.event(
          c,
          'note',
          `No app found behind the calls yet (try ${tries}); looking again`,
        );
        return { wait: Math.max(10_000, 30_000 / deps.config.speed) };
      }
    }
    c.scope = scope;
    deps.store.event(
      c,
      'decision',
      `Triage (${source}, ${Math.round((Date.now() - started) / 1000)}s): ${scope.summary}. ` +
        `${scope.affected_apps.length} app(s) since ${hhmm(scope.onset)}, suggested impact ${scope.suggested_impact} / urgency ${scope.suggested_urgency} (${scope.severity_reason})`,
      { data: { log_links: scope.log_links } },
    );
    const out = scope.grouping.filter((g) => !g.belongs && c.apps.includes(g.tla));
    if (out.length && out.length < c.apps.length) {
      for (const g of out) {
        splitOff(deps, ctx, c, [g.tla], g.reason);
      }
    }
    return { next: 'triaged', why: scope.summary };
  };
}

export function flowSteps(deps: FlowDeps): Partial<Record<Phase, StepFn>> {
  return {
    detected: detected(deps),
  };
}

/** Posts the failure where people will see it (the channel, when there is one). */
export async function reportFailure(deps: FlowDeps, c: Case, reason: string): Promise<void> {
  deps.log.error(`${c.id} failed: ${reason}`);
}
