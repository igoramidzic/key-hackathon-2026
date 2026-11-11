/**
 * Verify recovery and resolve (#24). After KBR deploys the fix, confirm the errors are gone (back
 * near baseline for a sustained window), then draft the resolution so a human only reviews and
 * resolves it, or resolve it outright with AGENT_AUTO_RESOLVE.
 */
import type { Case } from '../cases/types';
import { duration, errorMessage, hhmm, isoNow } from '../util';
import { logLink, type Summary, sinceClause, tlaClause } from './logs';
import { failingApps } from './rca';
import type { FlowDeps } from './steps';

async function errors(
  deps: FlowDeps,
  c: Case,
  apps: string[],
  since: string,
  until?: string,
): Promise<number> {
  const res = await deps.mcp.call<Summary>(
    'summarize_errors',
    {
      app_tla: apps.join(','),
      severity_min: 'ERROR',
      start_time: since,
      ...(until ? { end_time: until } : {}),
      limit: 100,
    },
    { caseId: c.id, quiet: true },
  );
  return res.total_matched;
}

const perMin = (count: number, fromMs: number, toMs: number) =>
  count / Math.max(0.25, (toMs - fromMs) / 60_000);

export interface VerifyResult {
  status: 'healthy' | 'recovering' | 'timeout';
  beforePerMin: number;
  afterPerMin: number;
  thresholdPerMin: number;
}

/** One verification round. Healthy needs the rate under threshold for `healthySec` in a row. */
export async function verifyRecovery(
  deps: FlowDeps,
  c: Case,
  now = Date.now(),
): Promise<VerifyResult> {
  const apps = failingApps(c);
  const deployed = Date.parse(c.change?.deployed_at ?? c.milestones.verifying ?? isoNow());
  const onset = Date.parse(c.scope?.onset ?? c.onset_at ?? c.opened_at);
  if (!c.verification) {
    const before = perMin(
      await errors(deps, c, apps, new Date(onset).toISOString(), new Date(deployed).toISOString()),
      onset,
      deployed,
    );
    c.verification = {
      before_per_min: before,
      after_per_min: null,
      healthy_since: null,
      started_at: new Date(deployed).toISOString(),
      logs_url: null,
    };
  }
  const v = c.verification;
  // Background errors never stop: compare with the same apps before the incident.
  const baseFrom = onset - 15 * 60_000;
  const baseline = perMin(
    await errors(
      deps,
      c,
      apps,
      new Date(baseFrom).toISOString(),
      new Date(onset - 60_000).toISOString(),
    ),
    baseFrom,
    onset - 60_000,
  );
  const threshold = Math.max(2 * baseline, 0.05 * v.before_per_min, 1);
  const windowMs = Math.min(60_000, deps.config.verify.healthySec * 1000);
  const from = Math.max(deployed, now - windowMs);
  const after = perMin(await errors(deps, c, apps, new Date(from).toISOString()), from, now);
  v.after_per_min = Math.round(after * 100) / 100;
  const healthyNow = now - deployed >= Math.min(windowMs, 15_000) && after <= threshold;
  if (healthyNow) v.healthy_since ??= new Date(now).toISOString();
  else v.healthy_since = null;
  deps.store.save(c);
  const result = { beforePerMin: v.before_per_min, afterPerMin: after, thresholdPerMin: threshold };
  if (v.healthy_since && now - Date.parse(v.healthy_since) >= deps.config.verify.healthySec * 1000)
    return { status: 'healthy', ...result };
  if (now - deployed > deps.config.verify.timeoutSec * 1000)
    return { status: 'timeout', ...result };
  return { status: 'recovering', ...result };
}

/** Logs link for the affected apps since the deploy (from search_logs). */
export async function afterLink(deps: FlowDeps, c: Case): Promise<string | null> {
  const apps = failingApps(c).slice(0, 12);
  if (!apps.length || !c.change?.deployed_at) return null;
  try {
    const link = await logLink(
      deps.mcp,
      `severity>=ERROR ${tlaClause(apps)} ${sinceClause(c.change.deployed_at)}`,
      c.id,
    );
    if (c.verification) c.verification.logs_url = link.logs_url;
    return link.logs_url;
  } catch (err) {
    deps.log.warn(`${c.id} after-link failed: ${errorMessage(err)}`);
    return null;
  }
}

/** The close notes: root cause, fix, timeline, time to detect and to restore. */
export function draftResolution(c: Case): {
  close_code: 'Resolved by change';
  close_notes: string;
} {
  const rc = c.root_cause;
  const onset = c.scope?.onset ?? c.onset_at ?? c.opened_at;
  const m = c.milestones;
  const detected = c.opened_at;
  const recovered = c.verification?.healthy_since ?? m.resolution_drafted ?? isoNow();
  const rows: [string, string | null | undefined][] = [
    ['Errors started', onset],
    ['Detected', detected],
    ['Incident declared', m.declared],
    ['Channel opened', m.assembled],
    ['Fix MR opened', m.fix_proposed],
    ['Fix merged', c.fix_mr?.merged_at],
    ['Promoted by KBR', c.change?.deployed_at],
    ['Recovered', recovered],
  ];
  const lines = [
    `Root cause: ${rc ? `${rc.culprit_tla} change ${rc.change_request?.number ?? ''} (${rc.merge_request ? `${rc.merge_request.project}!${rc.merge_request.iid} ${rc.merge_request.web_url}` : 'no MR'}). ${rc.mechanism}` : 'not confirmed'}`,
    `Fix: ${c.fix_mr ? `${c.fix_mr.project}!${c.fix_mr.iid} ${c.fix_mr.web_url}` : 'n/a'}${c.fix ? ` (${c.fix.strategy})` : ''}, promoted by emergency change ${c.change ? `${c.change.number} ${c.change.web_url}` : 'n/a'} at ${c.change?.deployed_at ?? 'n/a'}.`,
    `Impact: ${c.scope?.customer_impact ?? ''} Affected: ${(c.scope?.affected_apps ?? []).map((a) => a.tla).join(', ')}.`,
    c.verification
      ? `Verification: errors on the affected apps fell from ${c.verification.before_per_min.toFixed(1)}/min to ${(c.verification.after_per_min ?? 0).toFixed(1)}/min after the deploy${c.verification.logs_url ? ` (${c.verification.logs_url})` : ''}.`
      : '',
    '',
    'Timeline (UTC):',
    ...rows.filter(([, t]) => t).map(([label, t]) => `- ${hhmm(t)} ${label}`),
    '',
    `Time to detect: ${duration(Date.parse(detected) - Date.parse(onset))}. Time to restore: ${duration(Date.parse(recovered) - Date.parse(onset))}.`,
    c.children.length ? `Grouped caller incidents: ${c.children.join(', ')}.` : '',
  ];
  return {
    close_code: 'Resolved by change',
    close_notes: lines
      .filter((l, i, a) => l !== '' || a[i - 1] !== '')
      .join('\n')
      .trim(),
  };
}

/** Writes the drafted resolution; resolves the incident (and its children) when configured. */
export async function writeResolution(deps: FlowDeps, c: Case): Promise<{ resolved: boolean }> {
  const draft = draftResolution(c);
  const auto = deps.config.autoResolve;
  await deps.mcp.call(
    'update_incident',
    auto
      ? {
          number: c.incident!.number,
          state: 'resolved',
          close_code: draft.close_code,
          close_notes: draft.close_notes,
          work_note: 'Resolved automatically after verified recovery.',
        }
      : {
          number: c.incident!.number,
          state: 'in_progress',
          work_note: `Resolution drafted, please review and resolve:\n\nClose code: ${draft.close_code}\n${draft.close_notes}`,
        },
    { caseId: c.id },
  );
  c.resolution = { ...draft, drafted_at: isoNow(), resolved_at: auto ? isoNow() : null };
  deps.store.save(c);
  return { resolved: auto };
}

/** Resolves every alert the case linked. */
export async function resolveAlerts(deps: FlowDeps, c: Case): Promise<number> {
  let n = 0;
  for (const a of c.alerts) {
    if (a.resolved) continue;
    try {
      await deps.mcp.call(
        'update_alert',
        {
          id: a.id,
          status: 'resolved',
          note: `Recovered: ${c.incident?.number ?? c.id} resolved by ${c.change?.number ?? 'the fix'}`,
        },
        { caseId: c.id },
      );
      a.resolved = true;
      n++;
    } catch (err) {
      deps.log.warn(`${c.id} resolve alert ${a.id}: ${errorMessage(err)}`);
    }
  }
  deps.store.save(c);
  return n;
}
