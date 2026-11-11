/**
 * The incident flow: one step function per phase. Each step is idempotent: it can run again
 * after a crash or a retry without creating anything twice.
 */
import type { Orchestrator, StepContext, StepFn } from '../cases/orchestrator';
import type { CaseStore } from '../cases/store';
import type { Case, Phase } from '../cases/types';
import type { AgentConfig } from '../config';
import type { Correlator } from '../correlate/correlator';
import type { DependencyGraph } from '../correlate/graph';
import type { Logger } from '../log';
import type { Mcp } from '../mcp/gateway';
import {
  appsJoined,
  briefing,
  changeRaised,
  failure,
  fixReady,
  promoted,
  rootCauseUpdate,
} from '../messages/teams';
import type { PhaseRunner } from '../phases/runner';
import { hhmm } from '../util';
import { flush, postNow, queue, wasAnnounced } from './announce';
import { assembleChannel, notInvited, syncMembers, upstreamSuspect } from './assemble';
import { openFixMr, proposeFix, reviewers } from './fix';
import { declareIncident, linkAlerts, syncIncidentApp, workNote } from './incident';
import { deepRca, quickRca } from './rca';
import { splitOff } from './regroup';
import { checkMerge, followChange, raiseChange } from './ship';
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

/** Background deep RCA (#17). Stores the root cause; later steps announce changes. */
export function startDeepRca(
  deps: FlowDeps,
  ctx: StepContext,
  c: Case,
  opts: { hint?: string; force?: boolean } = {},
): boolean {
  const name = 'deep_rca';
  if (ctx.isRunning(c, name)) return false;
  // Runs once; a human hint or a failed verification asks for another pass explicitly.
  const done = c.background[name];
  if (!opts.force && done && done.state !== 'failed') return false;
  if (!opts.force && done?.state === 'failed' && done.runs >= 3) return false;
  const hint = opts.hint;
  return ctx.spawn(c, name, async () => {
    const started = Date.now();
    const { rootCause, source } = await deepRca(deps, c, hint);
    const current = deps.store.get(c.id) ?? c;
    if (!rootCause) {
      deps.store.event(current, 'decision', 'Deep RCA found no promoted change near the onset');
      return;
    }
    const before = current.root_cause;
    current.root_cause = rootCause;
    current.milestones.root_cause ??= new Date().toISOString();
    const top = current.suspects[0];
    deps.store.event(
      current,
      'decision',
      `Root cause (${source}, ${Math.round(rootCause.confidence * 100)}%, ${Math.round((Date.now() - started) / 1000)}s): ` +
        `${rootCause.culprit_tla} ${rootCause.change_request?.number ?? ''} ${rootCause.merge_request ? `${rootCause.merge_request.project}!${rootCause.merge_request.iid}` : ''}: ${rootCause.mechanism}` +
        (top && top.tla !== rootCause.culprit_tla
          ? ` (disagrees with the quick pass, which suspected ${top.tla})`
          : '') +
        (before && before.culprit_tla !== rootCause.culprit_tla
          ? ` (was ${before.culprit_tla})`
          : ''),
      { url: rootCause.merge_request?.web_url ?? rootCause.change_request?.web_url },
    );
    // Another open case with the same culprit is the same problem (#29 merges them).
    for (const other of deps.store.open()) {
      if (other.id === current.id || other.root_cause?.culprit_tla !== rootCause.culprit_tla)
        continue;
      if (other.root_cause.change_request?.number !== rootCause.change_request?.number) continue;
      deps.store.event(current, 'decision', `Same culprit as ${other.id}: flagged for merging`);
      deps.store.event(other, 'decision', `Same culprit as ${current.id}: flagged for merging`);
    }
  });
}

/** triaged: quick RCA (suspects for the briefing), then deep RCA in the background. */
export function triaged(deps: FlowDeps): StepFn {
  return async (c, ctx) => {
    if (c.suspects.length === 0 && !c.milestones.quick_rca) {
      const started = Date.now();
      c.suspects = await quickRca(deps, c);
      c.milestones.quick_rca = new Date().toISOString();
      deps.store.event(
        c,
        'decision',
        c.suspects.length
          ? `Quick RCA (${Math.round((Date.now() - started) / 1000)}s): ${c.suspects
              .map(
                (s) =>
                  `${s.tla} ${s.change_request?.number ?? ''} ${Math.round(s.confidence * 100)}%`,
              )
              .join(', ')}. Top: ${c.suspects[0]!.reason}`
          : 'Quick RCA: no change was promoted near the onset on the failing apps or their upstreams',
        { url: c.suspects[0]?.merge_request?.web_url },
      );
    }
    startDeepRca(deps, ctx, c);

    // A case split off another one only gets an incident if its app is still failing.
    if (c.split_from && !(c.scope?.affected_apps ?? []).some((a) => a.error_count > 0)) {
      return { next: 'abandoned', why: `split from ${c.split_from} and no longer failing` };
    }

    // #18: declare the incident and link the alerts.
    await declareIncident(deps, c);
    await linkAlerts(deps, c);
    return { next: 'declared', why: `${c.incident!.number} opened` };
  };
}

/**
 * Upkeep every phase after declaring runs first: link new alerts, re-point the incident when the
 * deep RCA names a different culprit. Cheap and idempotent.
 */
export async function upkeep(deps: FlowDeps, c: Case): Promise<void> {
  if (!c.incident) return;
  const fresh = c.signals.some(
    (s) => s.source === 'alert' && !c.alerts.some((a) => a.id === s.alert_id),
  );
  if (fresh) await linkAlerts(deps, c);
  await syncIncidentApp(deps, c);
  // #20: status updates for what changed since the briefing.
  if (wasAnnounced(c, 'briefing')) {
    announceChanges(deps, c);
    await flush(deps, c);
  }
  // #19: late joiners (a new failing app, a new upstream suspect, the change author, the service
  // desk once callers are grouped). Only recomputed when one of those inputs changes.
  if (c.channel) {
    const key = membershipKey(deps, c);
    if (c.milestones.members_key !== key) {
      await syncMembers(deps, c);
      c.milestones.members_key = key;
      deps.store.save(c);
    }
  }
}

function membershipKey(deps: FlowDeps, c: Case): string {
  const suspect = upstreamSuspect(deps, c);
  const mr = c.root_cause?.merge_request ?? c.suspects[0]?.merge_request;
  return [
    [...c.apps].sort().join(','),
    suspect?.tla ?? '',
    mr ? `${mr.project}!${mr.iid}` : '',
    c.children.length > 0 ? 'callers' : '',
  ].join('|');
}

/** Queues updates for what changed: the root cause, apps that joined (#20). */
export function announceChanges(deps: FlowDeps, c: Case): void {
  const graph = deps.graph();
  const rc = c.root_cause;
  if (rc) {
    const key = `root_cause:${rc.culprit_tla}:${rc.change_request?.number ?? ''}`;
    const prev = c.milestones.rc_announced;
    if (prev !== key) {
      const [, tla, number] = (prev ?? '').split(':');
      const previous = tla
        ? { tla, number }
        : c.suspects[0]
          ? { tla: c.suspects[0].tla, number: c.suspects[0].change_request?.number }
          : null;
      if (queue(deps, c, key, rootCauseUpdate(c, rc, previous))) c.milestones.rc_announced = key;
    }
  }
  const known = new Set((c.milestones.announced_apps ?? '').split(',').filter(Boolean));
  const fresh = c.apps.filter((a) => !known.has(a));
  if (fresh.length && c.milestones.announced_apps !== undefined) {
    queue(deps, c, `apps:${[...fresh].sort().join(',')}`, appsJoined(c, graph, fresh));
  }
  if (fresh.length || c.milestones.announced_apps === undefined) {
    c.milestones.announced_apps = c.apps.join(',');
    deps.store.save(c);
  }
}

/** assembled → briefed: the first message in the channel (#20). */
export function assembled(deps: FlowDeps): StepFn {
  return async (c) => {
    await upkeep(deps, c);
    const pending = await notInvited(deps, c);
    await postNow(
      deps,
      c,
      'briefing',
      briefing(c, deps.graph(), {
        notInvited: pending.map((i) => ({ user: i.user, reason: i.reason })),
      }),
      `Briefing posted in Teams #${c.channel?.name}: ${c.channel?.web_url}`,
    );
    c.milestones.announced_apps = c.apps.join(',');
    if (c.root_cause)
      c.milestones.rc_announced = `root_cause:${c.root_cause.culprit_tla}:${c.root_cause.change_request?.number ?? ''}`;
    deps.store.save(c);
    return { next: 'briefed', why: 'briefing posted' };
  };
}

/** briefed → investigating: deep RCA and the fix run in the background; upkeep announces. */
export function briefed(deps: FlowDeps): StepFn {
  return async (c, ctx) => {
    startDeepRca(deps, ctx, c);
    return { next: 'investigating' };
  };
}

/** True when the case knows its culprit well enough to write a fix. */
export function fixReadyToStart(deps: FlowDeps, c: Case): boolean {
  const threshold = deps.config.rcaConfidence;
  if (c.root_cause)
    return c.root_cause.confidence >= threshold && Boolean(c.root_cause.merge_request);
  // Deep RCA gave up: fall back to a confident quick suspect.
  const deep = c.background.deep_rca;
  const top = c.suspects[0];
  return Boolean(
    deep && deep.state !== 'running' && top?.merge_request && top.confidence >= threshold,
  );
}

/** Background fix generation (#22). */
export function startFix(deps: FlowDeps, ctx: StepContext, c: Case, force = false): boolean {
  const name = 'fix';
  if (ctx.isRunning(c, name) || c.fix_mr) return false;
  const prev = c.background[name];
  if (!force && prev && (prev.state === 'done' || prev.runs >= 3)) return false;
  return ctx.spawn(c, name, async () => {
    const { fix, source, problems } = await proposeFix(deps, c);
    const current = deps.store.get(c.id) ?? c;
    if (!fix) {
      deps.store.event(current, 'decision', `No automatic fix: ${problems.join('; ')}`);
      queue(deps, current, `no_fix:${problems.join(';').slice(0, 60)}`, {
        body: `**I couldn't build a safe automatic fix** (${problems.join('; ')}). Please propose one; I'll pick it up and promote it once it's merged.`,
        mentions: [],
        importance: 'high',
      });
      return;
    }
    deps.store.event(
      current,
      'decision',
      `Fix proposal (${source}, ${fix.strategy}): ${fix.title} — ${fix.changes.length} edit(s)${problems.length ? `; skipped: ${problems.join('; ')}` : ''}`,
    );
    await openFixMr(deps, current, fix);
  });
}

/** investigating: deep RCA in the background; once it's confident, write the fix (#22). */
export function investigating(deps: FlowDeps): StepFn {
  return async (c, ctx) => {
    await upkeep(deps, c);
    if (c.fix_mr) return { next: 'fix_proposed', why: `${c.fix_mr.project}!${c.fix_mr.iid}` };
    if (fixReadyToStart(deps, c)) startFix(deps, ctx, c);
    else startDeepRca(deps, ctx, c);
    return { wait: Math.max(2_000, 10_000 / deps.config.speed) };
  };
}

/** fix_proposed → awaiting_merge: ask the owners to review and merge (#22). */
export function fixProposed(deps: FlowDeps): StepFn {
  return async (c) => {
    await upkeep(deps, c);
    const who = await reviewers(deps, c);
    await flush(deps, c, true);
    await postNow(
      deps,
      c,
      `fix_ready:${c.fix_mr!.iid}`,
      fixReady(c, who),
      `Fix ready for review: ${c.fix_mr!.web_url}`,
    );
    return {
      next: 'awaiting_merge',
      why: `waiting for a human to merge ${c.fix_mr!.project}!${c.fix_mr!.iid}`,
    };
  };
}

/** awaiting_merge → shipping: a human merges the fix in GitLab (#23). */
export function awaitingMerge(deps: FlowDeps): StepFn {
  return async (c) => {
    await upkeep(deps, c);
    const state = await checkMerge(deps, c);
    if (state === 'merged')
      return { next: 'shipping', why: `${c.fix_mr!.project}!${c.fix_mr!.iid} merged` };
    if (state === 'closed') {
      const mr = c.fix_mr!;
      await flush(deps, c, true);
      await postNow(
        deps,
        c,
        `fix_closed:${mr.iid}`,
        {
          body: `**${mr.project}!${mr.iid} was closed without merging.** What's wrong with it? Tell me here and I'll rework the fix: ${mr.web_url}`,
          mentions: [],
          importance: 'high',
        },
        `Fix ${mr.web_url} was closed without merging; asked the channel what to change.`,
      );
      c.milestones.fix_attempt = String(Number(c.milestones.fix_attempt ?? '1') + 1);
      c.fix_mr = null;
      deps.store.save(c);
      return { next: 'investigating', why: 'fix MR closed without merging' };
    }
    return { wait: Math.max(3_000, 10_000 / deps.config.speed) };
  };
}

/** shipping → verifying: emergency change, KBR promotes it (#23). */
export function shipping(deps: FlowDeps): StepFn {
  return async (c) => {
    await upkeep(deps, c);
    const poll = { wait: Math.max(2_000, 5_000 / deps.config.speed) };
    if (!c.change) {
      await raiseChange(deps, c);
      await flush(deps, c, true);
      await postNow(deps, c, `change:${c.change!.number}`, changeRaised(c), null);
      return poll;
    }
    const progress = await followChange(deps, c);
    if (progress.status === 'deployed') {
      await postNow(deps, c, `promoted:${c.change.number}`, promoted(c), null);
      return { next: 'verifying', why: `KBR promoted ${c.change.number}` };
    }
    if (progress.status === 'aborted')
      queue(deps, c, `kbr_abort:${c.change.number}`, {
        body: `**KBR sent ${c.change.number} back:** ${progress.note}. ${c.fix_mr ? `Please merge ${c.fix_mr.web_url} first; I'll reschedule the change as soon as it is merged.` : ''}`,
        mentions: [],
        importance: 'high',
      });
    if (progress.status === 'retried')
      queue(deps, c, `kbr_retry:${c.change.number}:${progress.note.slice(0, 30)}`, {
        body: `**Rescheduled ${c.change.number}** for now after KBR's note ("${progress.note}"): the fix is merged.`,
        mentions: [],
        importance: 'normal',
      });
    if (progress.status === 'canceled') {
      deps.store.event(c, 'decision', `${c.change.number} was canceled; raising a new change`);
      c.change = null;
      deps.store.save(c);
    }
    return poll;
  };
}

/** declared → assembled: the incident channel with the right people (#19). */
export function declared(deps: FlowDeps): StepFn {
  return async (c) => {
    await upkeep(deps, c);
    await assembleChannel(deps, c);
    c.milestones.members_key = membershipKey(deps, c);
    return { next: 'assembled', why: `#${c.channel!.name} with ${c.members.length} people` };
  };
}

export function flowSteps(deps: FlowDeps): Partial<Record<Phase, StepFn>> {
  return {
    detected: detected(deps),
    triaged: triaged(deps),
    declared: declared(deps),
    assembled: assembled(deps),
    briefed: briefed(deps),
    investigating: investigating(deps),
    fix_proposed: fixProposed(deps),
    awaiting_merge: awaitingMerge(deps),
    shipping: shipping(deps),
  };
}

/** Posts the failure where people will see it (the channel, when there is one). */
export async function reportFailure(deps: FlowDeps, c: Case, reason: string): Promise<void> {
  deps.log.error(`${c.id} failed: ${reason}`);
  if (c.channel)
    await postNow(
      deps,
      c,
      `failure:${c.failure?.at ?? ''}`,
      failure(c, reason),
      `Automation stopped: ${reason}`,
    );
  else await workNote(deps, c, `Automation stopped: ${reason}`);
}
