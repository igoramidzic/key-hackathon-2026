/**
 * Moving apps between cases. Before an incident is declared this is cheap: only signals move
 * (#16 split). After declaring, #29 adds the incident, channel and alert bookkeeping.
 */
import type { StepContext } from '../cases/orchestrator';
import type { Case } from '../cases/types';
import { errorMessage, isoNow } from '../util';
import { incidentDescription } from './incident';
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

// ---------------------------------------------------------------------------
// #29: regrouping cases that already have an incident and a channel
// ---------------------------------------------------------------------------

const TERMINAL_PHASES = ['resolved', 'failed', 'abandoned'];

/** No flip-flopping: one regroup per case per window unless a human asked. */
export function regroupAllowed(deps: FlowDeps, c: Case, human: boolean): boolean {
  if (human || !c.last_regroup_at) return true;
  const windowMs = Math.max(60_000, (5 * 60_000) / deps.config.speed);
  return Date.now() - Date.parse(c.last_regroup_at) >= windowMs;
}

function prio(c: Case): number {
  return (
    c.incident?.priority ?? (c.scope ? c.scope.suggested_impact + c.scope.suggested_urgency : 9)
  );
}

/** Primary = the higher-priority case, the older one on a tie. */
export function pickPrimary(a: Case, b: Case): [Case, Case] {
  if (prio(a) !== prio(b)) return prio(a) < prio(b) ? [a, b] : [b, a];
  return a.opened_at <= b.opened_at ? [a, b] : [b, a];
}

/** The app the fix touches can't be split off (or the culprit). */
function protectedApps(c: Case): Set<string> {
  const out = new Set<string>();
  const project = c.fix_mr?.project ?? c.fix?.project;
  const tla = project?.match(/^[^/]+\/([A-Z]{2,5})00\//)?.[1];
  if (tla) out.add(tla);
  if (c.root_cause) out.add(c.root_cause.culprit_tla);
  return out;
}

/** Merges `secondary` into `primary`: one incident (the other a child), one active channel. */
export async function mergeCases(
  deps: FlowDeps,
  ctx: Pick<StepContext, 'cancel' | 'poke'>,
  a: Case,
  b: Case,
  reason: string,
  opts: { human?: boolean } = {},
): Promise<{ merged: boolean; why: string; primary?: Case }> {
  if (a.id === b.id) return { merged: false, why: 'same case' };
  if (TERMINAL_PHASES.includes(a.phase) || TERMINAL_PHASES.includes(b.phase))
    return { merged: false, why: 'one of the cases is already closed' };
  if (
    !regroupAllowed(deps, a, Boolean(opts.human)) ||
    !regroupAllowed(deps, b, Boolean(opts.human))
  )
    return { merged: false, why: 'regrouped too recently' };
  const [primary, secondary] = pickPrimary(a, b);
  const store = deps.store;

  if (primary.incident && secondary.incident) {
    // One level only: the secondary's children move to the primary first.
    for (const child of secondary.children) {
      try {
        await deps.mcp.call(
          'update_incident',
          { number: child, parent_incident: primary.incident.number },
          { caseId: primary.id },
        );
      } catch (err) {
        deps.log.warn(`move child ${child}: ${errorMessage(err)}`);
      }
    }
    await deps.mcp.call(
      'link_child_incidents',
      {
        parent: primary.incident.number,
        children: [secondary.incident.number],
        work_note: `${secondary.incident.number} is the same problem: ${reason}`,
      },
      { caseId: primary.id },
    );
    for (const al of secondary.alerts) {
      try {
        await deps.mcp.call(
          'update_alert',
          {
            id: al.id,
            incident_number: primary.incident.number,
            note: `Merged into ${primary.incident.number}`,
          },
          { caseId: primary.id },
        );
      } catch (err) {
        deps.log.warn(`re-point alert ${al.id}: ${errorMessage(err)}`);
      }
    }
  }
  if (secondary.channel && primary.channel) {
    await deps.mcp.call(
      'post_message',
      {
        channel: secondary.channel.id,
        body: `**Merged into #${primary.channel.name}** (${primary.channel.web_url}): ${reason}. Please continue there; I won't post here any more.`,
        importance: 'high',
      },
      { caseId: secondary.id },
    );
    const have = new Set(primary.members.map((m) => m.username));
    const joining = secondary.members.filter(
      (m) => !have.has(m.username) && m.username !== deps.config.identity,
    );
    if (joining.length) {
      await deps.mcp.call(
        'add_channel_members',
        {
          channel: primary.channel.id,
          members: joining.map((m) => ({
            user: m.username,
            reason: `joined from #${secondary.channel!.name}: same cause`,
          })),
        },
        { caseId: primary.id },
      );
      for (const m of joining)
        primary.members.push({
          username: m.username,
          reason: `joined from #${secondary.channel.name}: same cause`,
          role: 'member',
        });
    }
  }
  for (const task of Object.keys(secondary.background)) ctx.cancel(secondary, task);

  const newApps = secondary.apps.filter((t) => !primary.apps.includes(t));
  primary.apps.push(...newApps);
  for (const s of secondary.signals)
    if (!primary.signals.some((x) => x.id === s.id)) primary.signals.push(s);
  for (const r of secondary.relations)
    if (!primary.relations.some((x) => x.tla === r.tla))
      primary.relations.push({
        ...r,
        reasons: [`merged from ${secondary.id}: ${reason}`, ...r.reasons],
      });
  for (const al of secondary.alerts)
    if (!primary.alerts.some((x) => x.id === al.id)) primary.alerts.push(al);
  primary.children = [
    ...new Set([
      ...primary.children,
      ...secondary.children,
      ...(secondary.incident ? [secondary.incident.number] : []),
    ]),
  ];
  if (
    secondary.root_cause &&
    (!primary.root_cause || secondary.root_cause.confidence > primary.root_cause.confidence)
  )
    primary.root_cause = secondary.root_cause;
  if (primary.scope && secondary.scope)
    for (const a2 of secondary.scope.affected_apps)
      if (!primary.scope.affected_apps.some((x) => x.tla === a2.tla))
        primary.scope.affected_apps.push(a2);
  primary.upstream_candidates = deps.graph().commonUpstream(primary.apps);
  const now = isoNow();
  primary.last_regroup_at = now;
  secondary.last_regroup_at = now;
  secondary.merged_into = primary.id;
  store.event(
    secondary,
    'decision',
    `Merged into ${primary.id}${primary.incident ? ` (${primary.incident.number})` : ''}: ${reason}`,
  );
  store.setPhase(secondary, 'abandoned', `merged into ${primary.id}`);
  store.event(
    primary,
    'decision',
    `Merged ${secondary.id}${secondary.incident ? ` (${secondary.incident.number})` : ''} in: ${reason}. Added ${newApps.join(', ') || 'no new apps'}`,
    {
      data: { merged: secondary.id, apps: newApps, reason },
    },
  );
  if (primary.channel)
    await deps.mcp.call(
      'post_message',
      {
        channel: primary.channel.id,
        body: `**Merged ${secondary.incident?.number ?? 'another case'} into this incident** (${reason}).${newApps.length ? ` Also affected: ${newApps.map((t) => deps.graph().label(t)).join(', ')}.` : ''}${secondary.channel ? ` People from #${secondary.channel.name} have joined.` : ''}`,
      },
      { caseId: primary.id },
    );
  store.save(primary);
  ctx.poke(primary.id);
  return { merged: true, why: reason, primary };
}

/** Splits an app out of a case that already has an incident and a channel (#29). */
export async function splitApp(
  deps: FlowDeps,
  ctx: Pick<StepContext, 'track'>,
  c: Case,
  tla: string,
  reason: string,
  opts: { human?: boolean } = {},
): Promise<{ split: boolean; why: string; fresh?: Case }> {
  if (!c.apps.includes(tla)) return { split: false, why: `${tla} is not part of this incident` };
  if (protectedApps(c).has(tla))
    return { split: false, why: `${tla} is what the fix changes, so it stays` };
  if (c.apps.length <= 1) return { split: false, why: `${tla} is the only app in the incident` };
  if (!regroupAllowed(deps, c, Boolean(opts.human)))
    return { split: false, why: 'regrouped too recently' };
  const fresh = splitOff(deps, ctx, c, [tla], reason);
  if (!fresh) return { split: false, why: 'nothing to split' };
  if (c.incident) {
    await deps.mcp.call(
      'update_incident',
      {
        number: c.incident.number,
        description: incidentDescription(deps, c),
        work_note: `${tla} split out of this incident: ${reason}. Tracked separately (${fresh.id}); it gets its own incident only if it is still failing.`,
      },
      { caseId: c.id },
    );
  }
  if (c.channel) {
    await deps.mcp.call(
      'post_message',
      {
        channel: c.channel.id,
        body: `**Split ${deps.graph().label(tla)} out of this incident:** ${reason}. I'm tracking it separately; it gets its own incident and channel only if it is still failing.`,
      },
      { caseId: c.id },
    );
    // Their rep stays unless being on-call for that app was their only reason to be here.
    const sole = c.members.filter((m) => {
      const r = m.reason;
      return new RegExp(`^on-call for ${tla} \\(`).test(r) && !r.includes(';');
    });
    for (const m of sole) {
      try {
        await deps.mcp.call(
          'remove_channel_member',
          { channel: c.channel.id, user: m.username },
          { caseId: c.id },
        );
        c.members = c.members.filter((x) => x.username !== m.username);
        deps.store.event(
          c,
          'action',
          `Removed ${m.username} from #${c.channel.name}: only here for ${tla}`,
        );
      } catch (err) {
        deps.log.warn(`remove ${m.username}: ${errorMessage(err)}`);
      }
    }
  }
  deps.store.save(c);
  return { split: true, why: reason, fresh };
}

/** Automatic regroups from the deep RCA: unexplained apps split, same culprit merges. */
export async function autoRegroup(
  deps: FlowDeps,
  ctx: Pick<StepContext, 'track' | 'cancel' | 'poke'>,
  c: Case,
): Promise<void> {
  const rc = c.root_cause;
  if (!rc || rc.confidence < deps.config.rcaConfidence || TERMINAL_PHASES.includes(c.phase)) return;
  for (const u of rc.unexplained_apps) {
    const key = `split:${u.tla}`;
    if (c.milestones[key] || !c.apps.includes(u.tla)) continue;
    c.milestones[key] = isoNow();
    const r = await splitApp(
      deps,
      ctx,
      c,
      u.tla,
      `the root cause doesn't explain it (${u.reason})`,
    );
    deps.store.event(
      c,
      'decision',
      r.split ? `Split ${u.tla}: ${r.why}` : `Kept ${u.tla}: ${r.why}`,
    );
  }
  for (const other of deps.store.open()) {
    if (other.id === c.id || !other.root_cause || other.merged_into) continue;
    const same =
      other.root_cause.culprit_tla === rc.culprit_tla &&
      (other.root_cause.change_request?.number ?? '') === (rc.change_request?.number ?? '');
    const key = `merge:${[c.id, other.id].sort().join('+')}`;
    if (!same || c.milestones[key]) continue;
    c.milestones[key] = isoNow();
    const r = await mergeCases(
      deps,
      ctx,
      c,
      other,
      `same root cause (${rc.culprit_tla} ${rc.change_request?.number ?? ''})`,
    );
    deps.store.event(
      c,
      'decision',
      r.merged ? `Merged with ${other.id}` : `Not merged with ${other.id}: ${r.why}`,
    );
  }
}

/** The chat hook (#21): "<TLA> is unrelated" / "same as INC…". */
export function humanRegroup(deps: FlowDeps, ctx: Pick<StepContext, 'track' | 'cancel' | 'poke'>) {
  return async (
    c: Case,
    r: { kind: 'split' | 'merge'; tla?: string; incident?: string; by: string },
  ): Promise<string> => {
    if (r.kind === 'split' && r.tla) {
      const out = await splitApp(deps, ctx, c, r.tla, `@${r.by} says it is unrelated`, {
        human: true,
      });
      return out.split
        ? `Done: split ${r.tla} out of this incident. It's tracked separately.`
        : `I kept ${r.tla} in: ${out.why}.`;
    }
    if (r.kind === 'merge' && r.incident) {
      const other = deps.store
        .open()
        .find(
          (o) =>
            o.id !== c.id &&
            (o.incident?.number === r.incident || o.children.includes(r.incident!)),
        );
      if (other) {
        const out = await mergeCases(deps, ctx, c, other, `@${r.by} says it is the same problem`, {
          human: true,
        });
        return out.merged
          ? `Done: merged with ${r.incident}; this is now one incident (${out.primary!.incident?.number ?? ''}).`
          : `Not merged: ${out.why}.`;
      }
      if (c.incident) {
        await deps.mcp.call(
          'link_child_incidents',
          {
            parent: c.incident.number,
            children: [r.incident],
            work_note: `@${r.by} says ${r.incident} is the same problem`,
          },
          { caseId: c.id },
        );
        if (!c.children.includes(r.incident)) c.children.push(r.incident);
        deps.store.save(c);
        return `Done: ${r.incident} is now a child of ${c.incident.number}.`;
      }
    }
    return 'I couldn\'t tell what to regroup; name the app (e.g. "OLB is unrelated") or the incident ("same as INC0010205").';
  };
}
