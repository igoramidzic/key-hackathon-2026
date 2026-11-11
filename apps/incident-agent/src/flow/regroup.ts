/**
 * Moving apps between cases. Before an incident is declared this is cheap: only signals move
 * (#16 split). After declaring, #29 adds the incident, channel and alert bookkeeping.
 */
import type { StepContext } from '../cases/orchestrator';
import type { Case } from '../cases/types';
import { isoNow } from '../util';
import type { FlowDeps } from './steps';

/** Moves `tlas` (and their signals) out of `c` into a new case. Returns the new case. */
export function splitOff(
  deps: FlowDeps,
  ctx: Pick<StepContext, 'track'>,
  c: Case,
  tlas: string[],
  reason: string,
): Case | null {
  const moving = new Set(tlas.filter((t) => c.apps.includes(t)));
  if (moving.size === 0 || moving.size >= c.apps.length) return null;
  const signals = c.signals.filter((s) => s.source !== 'human' && moving.has(s.app_tla));
  const onset = signals.map((s) => (s.source === 'logs' ? s.first_seen : s.at)).sort()[0];
  const fresh = deps.store.create({
    kind: 'monitoring',
    apps: [...moving],
    onset_at: onset ?? isoNow(),
    settle_until: isoNow(),
    epoch: c.epoch,
    signals,
    split_from: c.id,
    relations: [...moving].map((tla) => ({
      tla,
      score: 1,
      reasons: [`split from ${c.id}: ${reason}`],
      tentative: false,
    })),
  });
  fresh.upstream_candidates = deps.graph().commonUpstream(fresh.apps);
  deps.store.event(fresh, 'decision', `Split from ${c.id}: ${reason}`);

  c.apps = c.apps.filter((t) => !moving.has(t));
  c.signals = c.signals.filter((s) => !signals.includes(s));
  c.relations = c.relations.filter((r) => !moving.has(r.tla));
  c.upstream_candidates = deps.graph().commonUpstream(c.apps);
  c.last_regroup_at = isoNow();
  if (c.scope) {
    c.scope.affected_apps = c.scope.affected_apps.filter((a) => !moving.has(a.tla));
    c.scope.signatures = c.scope.signatures.filter((s) => !moving.has(s.app_tla));
  }
  deps.store.event(c, 'decision', `Split ${[...moving].join(', ')} into ${fresh.id}: ${reason}`, {
    data: { split: [...moving], to: fresh.id },
  });
  ctx.track(fresh);
  return fresh;
}
