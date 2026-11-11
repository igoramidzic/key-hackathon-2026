import type { MergeRequest } from '@sim/contracts/gitlab';
import type {
  ChangeDeployment,
  ChangeMergeRequest,
  ChangeRequest,
} from '@sim/contracts/servicenow';
import { type App, PERSONAS, Rng } from '@sim/world';
import type { Estate } from './estate';
import { serviceForProject } from './run';
import type { Systems } from './systems';

/**
 * KBR (KeyBank Release): the only way code reaches production.
 *
 * Merging to `main` deploys to QV. A ServiceNow change request lists the merged MRs to promote and
 * a planned start; once that passes, KBR validates the MRs, rolls the merge commits out to
 * production, tags them in GitLab, notes each MR and closes the change.
 */

export const KBR_USER = PERSONAS.releaseBot;

/** Backfilled changes left scheduled for tonight's release window. */
const MAX_SCHEDULED_HISTORY = 6;

export interface KbrDeps {
  systems: Systems;
  estate: Estate;
  /** Rolls `sha` out to production for a service and emits rollout log lines. */
  deploy(
    app: App,
    service: string,
    sha: string,
    durationSec: number,
    meta?: Record<string, string>,
  ): void;
  now(): number;
  log(message: string): void;
  /** Called for every project promoted (scenario runs watch for their fix). */
  onPromoted?(promotion: Promotion): void | Promise<void>;
}

export interface Promotion {
  change: string;
  change_url: string;
  release_id: string;
  project: string;
  app: App | null;
  service: string | null;
  sha: string;
  /** MR titles promoted for this project. */
  titles: string[];
}

export type KbrResult =
  | { ok: true; change: ChangeRequest; release_id: string; deployments: ChangeDeployment[] }
  | { ok: false; reason: string; change?: ChangeRequest };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

export class Kbr {
  private readonly inflight = new Map<string, Promise<KbrResult>>();
  private seq = 0;
  private polling = false;
  releases = 0;

  constructor(private readonly deps: KbrDeps) {}

  /** Runs every scheduled change whose planned start has passed. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const page = await this.deps.systems.servicenow.listChanges({
        state: ['scheduled'],
        planned_before: new Date(this.deps.now()).toISOString(),
        sort: 'planned_start',
        limit: 20,
      });
      await Promise.all(page.items.map((c) => this.implement(c.number)));
    } catch (err) {
      this.deps.log(`[kbr] poll failed: ${errorMessage(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Promotes one change now (idempotent while it is in flight). */
  implement(number: string, opts: { rolloutSec?: number } = {}): Promise<KbrResult> {
    const existing = this.inflight.get(number);
    if (existing) return existing;
    const p = this.run(number, opts).finally(() => this.inflight.delete(number));
    this.inflight.set(number, p);
    return p;
  }

  /** Resolves once every release in flight has finished (tests, reset). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
  }

  private async run(number: string, opts: { rolloutSec?: number }): Promise<KbrResult> {
    const { servicenow, gitlab } = this.deps.systems;
    const now = this.deps.now();
    const releaseId = `KBR-${ymd(now)}-${String(++this.seq).padStart(4, '0')}`;

    let change: ChangeRequest;
    try {
      change = await servicenow.recordRelease(number, { status: 'running', release_id: releaseId });
    } catch (err) {
      // 409: someone else started it, or it is no longer scheduled.
      return { ok: false, reason: errorMessage(err) };
    }

    // 1. Validate: every MR must exist and be merged to main (i.e. be in QV).
    const resolved: ChangeMergeRequest[] = [];
    const merged = new Map<string, MergeRequest[]>();
    const problems: string[] = [];
    for (const ref of change.merge_requests) {
      try {
        const mr = await gitlab.getMergeRequest(ref.project, ref.iid);
        resolved.push({
          ...ref,
          title: mr.title,
          state: mr.state,
          merge_commit_sha: mr.merge_commit_sha,
        });
        if (mr.state !== 'merged' || !mr.merge_commit_sha) {
          problems.push(
            `${ref.reference} is ${mr.state}, not merged. KBR only promotes what is merged to main (QV).`,
          );
          continue;
        }
        const list = merged.get(ref.project) ?? [];
        list.push(mr);
        merged.set(ref.project, list);
      } catch (err) {
        resolved.push(ref);
        problems.push(`${ref.reference} could not be read from GitLab: ${errorMessage(err)}`);
      }
    }
    if (problems.length > 0) {
      const note = problems.map((p) => `- ${p}`).join('\n');
      this.deps.log(`[kbr] ${releaseId} ${number} aborted:\n${note}`);
      const failed = await servicenow
        .recordRelease(number, { status: 'failed', merge_requests: resolved, note })
        .catch(() => undefined);
      return { ok: false, reason: problems.join(' '), change: failed };
    }

    // 2. Promote: per project, the newest merge commit (it contains the earlier ones).
    const deployments: ChangeDeployment[] = [];
    const promotions: Promotion[] = [];
    for (const [project, mrs] of merged) {
      const head = [...mrs].sort((a, b) =>
        (b.merged_at ?? '').localeCompare(a.merged_at ?? ''),
      )[0]!;
      const sha = head.merge_commit_sha!;
      const target = serviceForProject(project);
      const tag = `kbr-${number}`;
      let tagged: string | null = tag;
      try {
        await gitlab.createTag(project, {
          tag_name: tag,
          ref: sha,
          message: `Promoted to production by ${releaseId} (${number})`,
          author: KBR_USER,
        });
      } catch {
        tagged = null;
      }
      let service: string | null = null;
      let version: string | null = null;
      if (target?.deployable) {
        service = target.service;
        if (target.app.emitsLogs) {
          this.deps.deploy(target.app, target.service, sha, opts.rolloutSec ?? 20, {
            change_number: number,
            release_id: releaseId,
          });
          version = this.deps.estate.get(target.app, target.service).version;
        }
      }
      deployments.push({
        project,
        app_tla: target?.app.tla ?? change.app.tla,
        service,
        sha,
        short_sha: sha.slice(0, 7),
        version,
        tag: tagged,
        deployed_at: new Date(this.deps.now()).toISOString(),
      });
      promotions.push({
        change: number,
        change_url: change.web_url,
        release_id: releaseId,
        project,
        app: target?.app ?? null,
        service,
        sha,
        titles: mrs.map((m) => m.title),
      });
      for (const mr of mrs) {
        await gitlab
          .addNote(project, mr.iid, {
            author: KBR_USER,
            body: `Promoted to **production** by KBR release \`${releaseId}\` under [${number}](${change.web_url}).${service ? ` \`${service}\` is now running \`${version ?? sha.slice(0, 7)}\`.` : ''}`,
          })
          .catch(() => undefined);
      }
    }

    // 3. Close the change.
    let closed: ChangeRequest;
    try {
      closed = await servicenow.recordRelease(number, {
        status: 'succeeded',
        merge_requests: resolved,
        deployments,
      });
    } catch (err) {
      this.deps.log(
        `[kbr] ${releaseId} ${number}: closing the change failed: ${errorMessage(err)}`,
      );
      closed = change;
    }
    this.releases++;
    this.deps.log(
      `[kbr] ${releaseId} ${number} promoted ${deployments.map((d) => `${d.project}@${d.short_sha}`).join(', ')}`,
    );
    for (const p of promotions) {
      try {
        await this.deps.onPromoted?.(p);
      } catch (err) {
        this.deps.log(`[kbr] onPromoted failed: ${errorMessage(err)}`);
      }
    }
    return { ok: true, change: closed, release_id: releaseId, deployments };
  }
}

/**
 * Backfills change history from GitLab: merged MRs of the last two weeks, grouped per project and
 * day, become closed KBR changes. Recent merges on non-hero apps are left scheduled for tonight,
 * like a real release calendar. Skipped when ServiceNow already has changes.
 */
export async function backfillChangeHistory(
  systems: Systems,
  now: number,
  log: (message: string) => void,
): Promise<number> {
  const { servicenow, gitlab } = systems;
  const existing = await servicenow.listChanges({ limit: 1 });
  if (existing.items.length > 0) return 0;
  const since = new Date(now - 14 * 86_400_000).toISOString();
  const mrs: MergeRequest[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 4; i++) {
    const page = await gitlab.listMergeRequests({
      state: 'merged',
      merged_after: since,
      order_by: 'merged_at',
      sort: 'desc',
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    mrs.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  const groups = new Map<string, MergeRequest[]>();
  for (const mr of mrs) {
    if (!mr.merged_at || !mr.merge_commit_sha) continue;
    const key = `${mr.project_path}|${mr.merged_at.slice(0, 10)}`;
    const list = groups.get(key) ?? [];
    list.push(mr);
    groups.set(key, list);
  }

  const rng = new Rng('kbr:history');
  const entries = [...groups.values()]
    .map((list) => list.sort((a, b) => a.merged_at!.localeCompare(b.merged_at!)))
    .sort((a, b) => a.at(-1)!.merged_at!.localeCompare(b.at(-1)!.merged_at!))
    .slice(-80);
  // Tonight's release window, 22:00 UTC (or tomorrow's when that has passed).
  const tonight = new Date(now);
  tonight.setUTCHours(22, 0, 0, 0);
  if (tonight.getTime() <= now + 30 * 60_000) tonight.setUTCDate(tonight.getUTCDate() + 1);

  let created = 0;
  let seq = 0;
  let scheduled = 0;
  for (const list of entries) {
    const last = list.at(-1)!;
    const project = last.project_path;
    const target = serviceForProject(project);
    const tla = target?.app.tla ?? last.tla;
    const mergedMs = Date.parse(last.merged_at!);
    let planned = mergedMs + rng.int(2, 30) * 3_600_000;
    let state: 'closed' | 'scheduled' = 'closed';
    if (planned > now - 5 * 60_000) {
      // A few recent non-hero merges wait for tonight's window; the rest already went out.
      if (!target?.app.hero && scheduled < MAX_SCHEDULED_HISTORY) {
        scheduled++;
        state = 'scheduled';
        planned = tonight.getTime();
      } else {
        planned = Math.max(mergedMs + 10 * 60_000, now - rng.int(10, 120) * 60_000);
        if (planned > now - 60_000) planned = now - 60_000;
      }
    }
    const opened = Math.max(Date.parse(last.created_at), mergedMs - rng.int(10, 120) * 60_000);
    const releaseId = `KBR-${ymd(planned)}-${String(++seq).padStart(4, '0')}`;
    const sha = last.merge_commit_sha!;
    const deployments: ChangeDeployment[] =
      state === 'closed'
        ? [
            {
              project,
              app_tla: tla,
              service: target?.deployable ? target.service : null,
              sha,
              short_sha: sha.slice(0, 7),
              version: null,
              tag: null,
              deployed_at: new Date(planned).toISOString(),
            },
          ]
        : [];
    const repo = project.split('/').at(-1)!;
    try {
      await servicenow.importChange({
        short_description: (list.length === 1
          ? `${repo}: ${last.title}`
          : `${repo}: promote ${list.length} changes to production`
        ).slice(0, 160),
        description: list.map((m) => `- ${m.references.full} ${m.title}`).join('\n'),
        app_tla: tla,
        merge_requests: list.map((m) => ({
          project,
          iid: m.iid,
          reference: m.references.full,
          web_url: m.web_url,
          title: m.title,
          state: 'merged',
          merge_commit_sha: m.merge_commit_sha,
        })),
        type: list.some((m) => m.labels.includes('documentation')) ? 'standard' : 'normal',
        risk: 'low',
        state,
        requested_by: last.author.username,
        opened_at: new Date(Math.min(opened, planned - 60_000)).toISOString(),
        planned_start: new Date(planned).toISOString(),
        release_id: state === 'closed' ? releaseId : undefined,
        deployments,
      });
      created++;
    } catch (err) {
      log(`[kbr] history import for ${project} failed: ${errorMessage(err)}`);
    }
  }
  log(`[kbr] Backfilled ${created} change requests from ${mrs.length} merged MRs`);
  return created;
}
