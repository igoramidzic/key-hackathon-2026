/**
 * Shipping the fix (#23). Merging only deploys to QV; production needs a ServiceNow change
 * request that KBR (svc_kbr) promotes. The agent watches for the human merge, raises an emergency
 * change with planned_start "now", follows KBR, and recovers from a KBR abort.
 */
import { ensureOnce } from '../actions/ensure';
import type { Case } from '../cases/types';
import { errorMessage, isoNow } from '../util';
import { addLinks, workNote } from './incident';
import type { ChangeDetail, MrDetail } from './rca';
import type { FlowDeps } from './steps';

/** keybank/CIF00/customer-profile-api → CIF */
export function tlaOfProject(project: string): string | null {
  return project.match(/^[^/]+\/([A-Z]{2,5})00\//)?.[1] ?? null;
}

export type MergeState = 'merged' | 'closed' | 'opened';

/** Refreshes the fix MR; returns its state. */
export async function checkMerge(deps: FlowDeps, c: Case): Promise<MergeState> {
  const ref = c.fix_mr!;
  const mr = await deps.mcp.call<MrDetail>(
    'get_merge_request',
    { project: ref.project, iid: ref.iid },
    { caseId: c.id, quiet: true },
  );
  if (mr.state === 'merged') {
    c.fix_mr = {
      ...ref,
      state: 'merged',
      merged_at: mr.merged_at,
      merge_commit_sha: mr.merge_commit_sha,
    };
    const by = typeof mr.merged_by === 'string' ? mr.merged_by : mr.merged_by?.username;
    deps.store.event(
      c,
      'action',
      `${ref.project}!${ref.iid} merged${by ? ` by ${by}` : ''} (QV only until promoted)`,
      { url: ref.web_url },
    );
    return 'merged';
  }
  if (mr.state === 'closed') {
    c.fix_mr = { ...ref, state: 'closed' };
    deps.store.save(c);
    return 'closed';
  }
  return 'opened';
}

interface ChangeRow {
  number: string;
  state: string;
  web_url: string;
  related_incidents?: string[];
}

/** Raises (or adopts) the emergency change for the merged fix. */
export async function raiseChange(
  deps: FlowDeps,
  c: Case,
): Promise<'existing' | 'found' | 'created'> {
  const mr = c.fix_mr!;
  const ref = `${mr.project}!${mr.iid}`;
  const tla = tlaOfProject(mr.project) ?? c.root_cause?.culprit_tla ?? c.incident?.app_tla ?? '';
  const { how } = await ensureOnce({
    current: () => c.change,
    lookup: async () => {
      const res = await deps.mcp.call<{ items: ChangeRow[] }>(
        'list_change_requests',
        {
          merge_request: ref,
          ...(c.incident ? { related_incident: c.incident.number } : {}),
          limit: 10,
        },
        { caseId: c.id },
      );
      const ch = res.items.find((x) => x.state !== 'canceled');
      return ch
        ? { number: ch.number, web_url: ch.web_url, state: ch.state, deployed_at: null }
        : null;
    },
    create: async () => {
      const ch = await deps.mcp.call<ChangeRow>(
        'create_change_request',
        {
          short_description:
            `${tla} - ${c.fix?.title ?? `fix for ${c.incident?.number ?? 'incident'}`}`.slice(
              0,
              160,
            ),
          app_tla: tla,
          merge_requests: [ref],
          planned_start: 'now',
          type: 'emergency',
          description: [
            `Promotes ${mr.web_url} to fix ${c.incident ? `${c.incident.number} (${c.incident.web_url})` : 'a live incident'}.`,
            c.root_cause
              ? `Root cause: ${c.root_cause.change_request?.number ?? ''} ${c.root_cause.merge_request?.web_url ?? ''}. ${c.root_cause.mechanism}`
              : '',
            c.fix ? `Fix: ${c.fix.strategy}. ${c.fix.justification}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          justification: c.scope?.customer_impact ?? 'Restores service for a live incident.',
          backout_plan: 'KBR rollback release to the previous production version.',
          ...(c.incident ? { related_incidents: [c.incident.number] } : {}),
        },
        { caseId: c.id },
      );
      return { number: ch.number, web_url: ch.web_url, state: ch.state, deployed_at: null };
    },
    record: (value) => {
      c.change = value;
      deps.store.save(c);
    },
  });
  if (how === 'created' || how === 'found') {
    await addLinks(
      deps,
      c,
      [{ type: 'other', url: c.change!.web_url, title: `Emergency change ${c.change!.number}` }],
      `Fix ${ref} merged; emergency change ${c.change!.number} raised for KBR to promote now: ${c.change!.web_url}`,
    );
  }
  deps.store.event(
    c,
    'action',
    `${how === 'created' ? 'Raised' : 'Adopted'} emergency change ${c.change!.number}`,
    { url: c.change!.web_url },
  );
  return how;
}

export type ChangeProgress =
  | { status: 'deployed'; at: string }
  | { status: 'waiting' }
  | { status: 'aborted'; note: string }
  | { status: 'retried'; note: string }
  | { status: 'canceled' };

/** Follows the change: deployed, still waiting, or aborted by KBR (retried once the MR is merged). */
export async function followChange(deps: FlowDeps, c: Case): Promise<ChangeProgress> {
  const ch = await deps.mcp.call<
    ChangeDetail & {
      journal?: { text: string; author?: { username: string } }[];
      release?: { status: string };
    }
  >('get_change_request', { number: c.change!.number }, { caseId: c.id, quiet: true });
  c.change = { ...c.change!, state: ch.state };
  if (ch.state === 'closed' || (ch.deployments?.length ?? 0) > 0) {
    const at =
      (ch.deployments ?? [])
        .map((d) => d.deployed_at)
        .sort()
        .at(-1) ??
      ch.implemented_at ??
      isoNow();
    c.change.deployed_at = at;
    deps.store.event(c, 'action', `KBR promoted ${c.change.number} to production`, {
      url: c.change.web_url,
    });
    return { status: 'deployed', at };
  }
  if (ch.state === 'canceled') return { status: 'canceled' };
  if (ch.state === 'new') {
    // KBR sent it back. Read why, fix the cause (usually: the MR isn't merged), reschedule.
    const note =
      [...(ch.journal ?? [])].reverse().find((j) => j.author?.username === 'svc_kbr')?.text ??
      'sent back to new';
    const merge = c.fix_mr ? await checkMerge(deps, c) : 'opened';
    if (merge !== 'merged') return { status: 'aborted', note };
    const key = `retry:${note.slice(0, 40)}`;
    if (c.milestones[key]) return { status: 'waiting' };
    await deps.mcp.call(
      'update_change_request',
      {
        number: c.change.number,
        planned_start: 'now',
        work_note: `Retrying after KBR's note ("${note}"): ${c.fix_mr?.project}!${c.fix_mr?.iid} is merged now.`,
      },
      { caseId: c.id },
    );
    c.milestones[key] = isoNow();
    deps.store.event(c, 'action', `KBR aborted ${c.change.number} (${note}); rescheduled for now`, {
      url: c.change.web_url,
    });
    return { status: 'retried', note };
  }
  return { status: 'waiting' };
}

export async function noteSafely(deps: FlowDeps, c: Case, text: string): Promise<void> {
  try {
    await workNote(deps, c, text);
  } catch (err) {
    deps.log.warn(errorMessage(err));
  }
}
