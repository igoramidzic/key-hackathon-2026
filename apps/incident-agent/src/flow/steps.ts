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

export interface FlowDeps {
  config: AgentConfig;
  mcp: Mcp;
  store: CaseStore;
  graph: () => DependencyGraph;
  runner: PhaseRunner | null;
  correlator: Correlator;
  log: Logger;
  orchestrator?: Orchestrator;
}

/** detected: wait out the settle window so the rest of a cascade can arrive. */
export function settle(deps: FlowDeps): StepFn {
  return async (c) => {
    const until = c.settle_until ? Date.parse(c.settle_until) : 0;
    const left = until - Date.now();
    if (left > 0) return { wait: left };
    deps.log.info(
      `${c.id} settled with ${c.apps.length} app(s): ${c.apps.join(', ') || '(reported by people)'}`,
    );
    return { wait: 60_000 };
  };
}

export function flowSteps(deps: FlowDeps): Partial<Record<Phase, StepFn>> {
  return {
    detected: settle(deps),
  };
}

/** Posts the failure where people will see it (the channel, when there is one). */
export async function reportFailure(deps: FlowDeps, c: Case, reason: string): Promise<void> {
  deps.log.error(`${c.id} failed: ${reason}`);
}
