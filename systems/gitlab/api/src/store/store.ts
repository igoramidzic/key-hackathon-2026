import { badRequest, conflict, notFound } from '@sim/api-kit';
import type {
  AdminCommitInput,
  AdminMergeInput,
  EventAction,
  FileDiff,
  PipelineStatus,
} from '@sim/contracts/gitlab';
import { heroRepoOverlays } from '@sim/scenarios';
import { type App, getWorld, ORG, PERSONAS, Rng, shaFor } from '@sim/world';
import { type PlannedEvent, planRepo } from '../history/plan';
import { normalizePath } from '../templates/index';
import { diffTrees, threeWayMerge } from './diff';
import { applyEdits, effectiveChanges, withChanges } from './edits';
import { materialize } from './materialize';
import {
  type BranchObj,
  type CommitObj,
  type Counters,
  type EventObj,
  MINUTE,
  type MrObj,
  type NoteObj,
  type RepoState,
  type TagObj,
  type TreeMap,
} from './types';

export interface GroupInfo {
  id: number;
  /** null for the root group. */
  tla: string | null;
  app: App | null;
  path: string;
  fullPath: string;
  name: string;
  description: string;
  parentId: number | null;
  projectIds: number[];
}

/** Open / closed MRs seeded instance-wide. */
const OPEN_MRS = 60;

export interface GitlabStoreOptions {
  /** Scales generated (non-hero) repos' seeded history length. Default 1. */
  historyScale?: number;
  /** Cap on repos whose file trees stay rendered in memory. Default unlimited. */
  maxMaterializedRepos?: number;
}
const CLOSED_MRS = 20;
/** Runtime-created MRs report a running pipeline for this long. */
const PIPELINE_RUN_MS = 30_000;
export const ROOT_GROUP_ID = 100;

export const DEFAULT_AUTHOR: string = PERSONAS.incidentBot;
export const DEFAULT_MERGER: string = PERSONAS.nocLead;

export function parseLabels(value: string[] | string | undefined | null): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : value.split(',');
  return [...new Set(list.map((l) => String(l).trim()).filter(Boolean))];
}

export class GitlabStore {
  readonly bootedAt: number;
  readonly repos = new Map<number, RepoState>();
  private readonly byPath = new Map<string, RepoState>();
  private readonly byName = new Map<string, RepoState[]>();
  readonly groups: GroupInfo[] = [];
  private readonly groupsById = new Map<number, GroupInfo>();
  private readonly groupsByKey = new Map<string, GroupInfo>();
  /** Sorted by `at` ascending. */
  readonly events: EventObj[] = [];
  readonly counters: Counters = { mr: 0, note: 0, pipeline: 0, event: 0, commit: 0 };
  /** username → TLAs of app groups they belong to. */
  readonly userTlas = new Map<string, string[]>();
  private readonly diffCache = new Map<string, FileDiff[]>();

  private readonly options: GitlabStoreOptions;
  /** Materialized repos, least recently used first (see GitlabStoreOptions.maxMaterializedRepos). */
  private readonly materializedLru = new Map<number, RepoState>();

  constructor(now = Date.now(), options: GitlabStoreOptions = {}) {
    this.options = options;
    this.bootedAt = now;
    const world = getWorld();

    // ----- groups -----
    const root: GroupInfo = {
      id: ROOT_GROUP_ID,
      tla: null,
      app: null,
      path: ORG.slug,
      fullPath: ORG.slug,
      name: ORG.slug,
      description: `${ORG.name} engineering. One subgroup per application, named <TLA>00 after the ServiceNow application code.`,
      parentId: null,
      projectIds: [],
    };
    this.addGroup(root);
    world.apps.forEach((app, i) => {
      const path = `${app.tla}00`;
      this.addGroup({
        id: ROOT_GROUP_ID + 1 + i,
        tla: app.tla,
        app,
        path,
        fullPath: `${ORG.slug}/${path}`,
        name: path,
        description: app.name,
        parentId: ROOT_GROUP_ID,
        projectIds: [],
      });
      for (const u of [app.ownerUsername, ...app.developerUsernames]) {
        const list = this.userTlas.get(u) ?? [];
        if (!list.includes(app.tla)) list.push(app.tla);
        this.userTlas.set(u, list);
      }
    });

    // ----- which repos get seeded open/closed MRs -----
    const sel = new Rng('gitlab:seed-mrs');
    const openCounts = new Map<number, number>();
    const closedCounts = new Map<number, number>();
    const candidates = world.repos.filter((r) => r.kind !== 'infra');
    for (let i = 0; i < OPEN_MRS; i++) {
      const repo = sel.pick(candidates);
      openCounts.set(repo.id, Math.min(2, (openCounts.get(repo.id) ?? 0) + 1));
    }
    for (let i = 0; i < CLOSED_MRS; i++) {
      const repo = sel.pick(candidates);
      closedCounts.set(repo.id, 1);
    }

    // ----- plan every repo -----
    const planned: PlannedEvent[] = [];
    for (const repo of world.repos) {
      const plan = planRepo(repo, {
        now,
        overlay: heroRepoOverlays[repo.path],
        openMrs: openCounts.get(repo.id) ?? 0,
        closedMrs: closedCounts.get(repo.id) ?? 0,
        historyScale: options.historyScale,
      });
      this.addRepo(plan.state);
      for (const e of plan.events) planned.push(e);
    }

    // ----- instance-wide ids, in chronological order -----
    const allMrs = [...this.repos.values()]
      .flatMap((s) => s.mrs)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const mr of allMrs) {
      mr.id = 24_000 + ++this.counters.mr;
      mr.pipeline.id = 480_000 + ++this.counters.pipeline;
    }
    const allNotes = allMrs.flatMap((m) => m.notes).sort((a, b) => a.createdAt - b.createdAt);
    for (const note of allNotes) note.id = 91_000 + ++this.counters.note;
    planned.sort((a, b) => a.at - b.at);
    for (const e of planned) this.events.push({ ...e, id: ++this.counters.event });
  }

  /**
   * Renders a repo's trees (cached) and tracks recency. With `maxMaterializedRepos`, the least
   * recently used purely-seeded repos are dropped from the cache; they re-render deterministically
   * on next use. Repos with runtime commits (merges, agent MRs) are never evicted.
   */
  private materialize(state: RepoState): void {
    materialize(state);
    this.materializedLru.delete(state.repo.id);
    this.materializedLru.set(state.repo.id, state);
    const max = this.options.maxMaterializedRepos;
    if (!max || this.materializedLru.size <= max) return;
    for (const [id, candidate] of this.materializedLru) {
      if (this.materializedLru.size <= max) break;
      if (candidate === state) continue;
      const seededOnly = candidate.order.every((sha) => candidate.commits.get(sha)!.seed);
      if (!seededOnly) continue;
      for (const sha of candidate.order) candidate.commits.get(sha)!.tree = undefined;
      candidate.materialized = false;
      this.materializedLru.delete(id);
    }
  }

  private addGroup(group: GroupInfo) {
    this.groups.push(group);
    this.groupsById.set(group.id, group);
    this.groupsByKey.set(group.fullPath.toLowerCase(), group);
    this.groupsByKey.set(group.path.toLowerCase(), group);
    if (group.tla) this.groupsByKey.set(group.tla.toLowerCase(), group);
  }

  private addRepo(state: RepoState) {
    const repo = state.repo;
    this.repos.set(repo.id, state);
    this.byPath.set(repo.path.toLowerCase(), state);
    this.byPath.set(repo.path.toLowerCase().replace(`${ORG.slug}/`, ''), state);
    const list = this.byName.get(repo.name) ?? [];
    list.push(state);
    this.byName.set(repo.name, list);
    this.groupsByKey.get(repo.tla.toLowerCase())?.projectIds.push(repo.id);
    this.groupsById.get(ROOT_GROUP_ID)!.projectIds.push(repo.id);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** Numeric id, `keybank/PAY00/payments-api`, `PAY00/payments-api`, or a unique repo name. */
  project(id: string | number): RepoState {
    const key = String(id)
      .trim()
      .replace(/^\/+|\/+$/g, '');
    if (/^\d+$/.test(key)) {
      const state = this.repos.get(Number(key));
      if (state) return state;
    }
    const byPath = this.byPath.get(key.toLowerCase());
    if (byPath) return byPath;
    const byName = this.byName.get(key);
    if (byName?.length === 1) return byName[0]!;
    throw notFound(
      `Project not found: ${key}. Use the full path keybank/<TLA>00/<repo> (e.g. keybank/PAY00/payments-api) or the numeric id.`,
    );
  }

  /** Numeric id, `keybank/PAY00`, `PAY00`, `PAY` or `keybank`. */
  group(id: string | number): GroupInfo {
    const key = String(id)
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const g = /^\d+$/.test(key)
      ? this.groupsById.get(Number(key))
      : this.groupsByKey.get(key.toLowerCase());
    if (!g)
      throw notFound(
        `Group not found: ${key}. Use keybank/<TLA>00 (e.g. keybank/PAY00) or the TLA.`,
      );
    return g;
  }

  allProjects(): RepoState[] {
    return [...this.repos.values()];
  }

  commit(state: RepoState, sha: string): CommitObj {
    const c = state.commits.get(sha);
    if (!c) throw notFound(`Commit not found: ${sha}`);
    return c;
  }

  /**
   * Branch, tag, full or short sha, or HEAD → commit sha, with git-style ancestry suffixes
   * (`main~2`, `HEAD^`, `v1.4.0^^`, first parent). Throws 404.
   */
  resolveRef(state: RepoState, ref?: string | null): string {
    const raw = (ref ?? '').trim() || state.repo.defaultBranch;
    const ancestry = raw.match(/^(.+?)((?:~\d*|\^)+)$/);
    if (ancestry) {
      let sha = this.resolveRef(state, ancestry[1]);
      for (const [, op, n] of ancestry[2]!.matchAll(/(~|\^)(\d*)/g)) {
        const steps = op === '~' ? Number(n || 1) : 1;
        for (let i = 0; i < steps; i++) {
          const parent = this.commit(state, sha).parents[0];
          if (!parent)
            throw notFound(
              `Ref not found: ${raw} goes past the first commit of ${state.repo.path}`,
            );
          sha = parent;
        }
      }
      return sha;
    }
    const r = raw;
    if (r === 'HEAD') return state.branches.get(state.repo.defaultBranch)!.head;
    const branch = state.branches.get(r);
    if (branch) return branch.head;
    const tag = state.tags.get(r);
    if (tag) return tag.target;
    if (/^[0-9a-f]{4,40}$/i.test(r)) {
      const lower = r.toLowerCase();
      if (state.commits.has(lower)) return lower;
      const matches = state.order.filter((sha) => sha.startsWith(lower));
      if (matches.length === 1) return matches[0]!;
    }
    throw notFound(`Ref not found: ${r} in ${state.repo.path}`);
  }

  tree(state: RepoState, sha: string): TreeMap {
    this.materialize(state);
    return this.commit(state, sha).tree!;
  }

  /** Commits reachable from `head`, newest first. */
  history(state: RepoState, head: string, firstParent = false): CommitObj[] {
    const seen = new Set<string>();
    const stack = [head];
    const out: CommitObj[] = [];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = state.commits.get(sha);
      if (!c) continue;
      out.push(c);
      if (firstParent) {
        if (c.parents[0]) stack.push(c.parents[0]);
      } else {
        for (const p of c.parents) stack.push(p);
      }
    }
    return out.sort((a, b) => b.committedAt - a.committedAt || b.seq - a.seq);
  }

  ancestors(state: RepoState, head: string): Set<string> {
    return new Set(this.history(state, head).map((c) => c.sha));
  }

  mergeBase(state: RepoState, a: string, b: string): string {
    const ancestorsOfB = this.ancestors(state, b);
    for (const c of this.history(state, a)) if (ancestorsOfB.has(c.sha)) return c.sha;
    return state.order[0]!;
  }

  /** Diff of a commit against its first parent (cached). */
  commitDiffs(state: RepoState, c: CommitObj): FileDiff[] {
    const key = `${state.repo.id}:${c.sha}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    this.materialize(state);
    const parent = c.parents[0] ? this.commit(state, c.parents[0]).tree : undefined;
    const diffs = diffTrees(parent, c.tree!);
    this.diffCache.set(key, diffs);
    return diffs;
  }

  /** Did this commit change `path` (a file or a directory prefix)? Merge commits never match. */
  touches(state: RepoState, c: CommitObj, path: string): boolean {
    if (c.parents.length > 1) return false;
    const p = normalizePath(path).replace(/\/$/, '');
    return this.commitDiffs(state, c).some(
      (d) => d.new_path === p || d.new_path.startsWith(`${p}/`),
    );
  }

  lastCommitFor(state: RepoState, head: string, path: string): CommitObj | undefined {
    return this.history(state, head).find((c) => this.touches(state, c, path));
  }

  mrHead(mr: MrObj): string {
    return mr.commits[mr.commits.length - 1]!;
  }

  mr(state: RepoState, iid: number): MrObj {
    const mr = state.mrs[iid - 1];
    if (!mr) throw notFound(`Merge request !${iid} not found in ${state.repo.path}`);
    return mr;
  }

  mrDiffs(state: RepoState, mr: MrObj): FileDiff[] {
    const key = `${state.repo.id}:mr:${mr.baseSha}:${this.mrHead(mr)}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    const diffs = diffTrees(this.tree(state, mr.baseSha), this.tree(state, this.mrHead(mr)));
    this.diffCache.set(key, diffs);
    return diffs;
  }

  pipelineStatus(mr: MrObj, now = Date.now()): PipelineStatus {
    const p = mr.pipeline;
    if (p.settleAt !== undefined) {
      if (now < p.settleAt) return 'running';
      return p.finalStatus ?? 'success';
    }
    return p.status;
  }

  /** Can the MR merge cleanly into its target right now? */
  mergeStatus(
    state: RepoState,
    mr: MrObj,
  ): 'can_be_merged' | 'cannot_be_merged' | 'merged' | 'closed' {
    if (mr.state === 'merged') return 'merged';
    if (mr.state === 'closed') return 'closed';
    const target = state.branches.get(mr.targetBranch);
    if (!target) return 'cannot_be_merged';
    const head = this.mrHead(mr);
    const base = this.mergeBase(state, target.head, head);
    if (base === target.head) return 'can_be_merged';
    const { conflicts } = threeWayMerge(
      this.tree(state, base),
      this.tree(state, target.head),
      this.tree(state, head),
    );
    return conflicts.length > 0 ? 'cannot_be_merged' : 'can_be_merged';
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  addEvent(state: RepoState, e: Omit<EventObj, 'id' | 'repoId'>) {
    const event: EventObj = { ...e, id: ++this.counters.event, repoId: state.repo.id };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.at > event.at) i--;
    this.events.splice(i, 0, event);
    state.lastActivityAt = Math.max(state.lastActivityAt, event.at);
  }

  private pushEvent(state: RepoState, ref: string, commit: CommitObj, isNew: boolean, at: number) {
    this.addEvent(state, {
      action: (isNew ? 'pushed new' : 'pushed to') satisfies EventAction,
      at,
      author: commit.author,
      targetType: null,
      targetIid: null,
      targetTitle: null,
      push: { ref, refType: 'branch', count: 1, to: commit.sha, title: commit.title },
    });
  }

  private mrEvent(state: RepoState, mr: MrObj, action: EventAction, author: string, at: number) {
    this.addEvent(state, {
      action,
      at,
      author,
      targetType: 'MergeRequest',
      targetIid: mr.iid,
      targetTitle: mr.title,
      push: null,
    });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  private newSha(state: RepoState, parent: string, message: string, at: number) {
    return shaFor(`${state.repo.path}:${parent}:${message}:${++this.counters.commit}:${at}`);
  }

  private addCommitObj(state: RepoState, c: Omit<CommitObj, 'seq'>): CommitObj {
    const commit: CommitObj = { ...c, seq: state.order.length };
    state.commits.set(commit.sha, commit);
    state.order.push(commit.sha);
    return commit;
  }

  /**
   * Commits `changes` on top of `branch` (created from `startRef` when missing). Throws 400 when
   * nothing changes. Updates open MRs whose source is the branch.
   */
  commitChanges(
    state: RepoState,
    opts: {
      branch: string;
      startRef?: string;
      message: string;
      author: string;
      changes: Map<string, string | null>;
      at?: number;
      emitEvent?: boolean;
    },
  ): CommitObj {
    this.materialize(state);
    const branchName = opts.branch.trim();
    if (!branchName) throw badRequest('branch is required');
    if (!opts.message.trim()) throw badRequest('commit message is required');
    const at = opts.at ?? Date.now();
    const existing = state.branches.get(branchName);
    const parentSha = existing
      ? existing.head
      : this.resolveRef(state, opts.startRef ?? state.repo.defaultBranch);
    const parent = this.commit(state, parentSha);
    const changes = effectiveChanges(parent.tree!, opts.changes);
    if (changes.size === 0) {
      throw badRequest('No changes: every edit matches the current file content');
    }
    const message = opts.message.trim();
    const commit = this.addCommitObj(state, {
      sha: this.newSha(state, parentSha, message, at),
      parents: [parentSha],
      title: message.split('\n')[0]!.slice(0, 200),
      message,
      author: opts.author,
      authoredAt: at,
      committedAt: at,
      mrIid: null,
      tree: withChanges(parent.tree!, changes),
    });
    if (existing) existing.head = commit.sha;
    else
      state.branches.set(branchName, {
        name: branchName,
        head: commit.sha,
        createdAt: at,
        protected: false,
      });
    for (const mr of state.mrs) {
      if (mr.state === 'opened' && mr.sourceBranch === branchName) {
        mr.commits.push(commit.sha);
        commit.mrIid = mr.iid;
        mr.updatedAt = at;
        mr.pipeline = {
          id: 480_000 + ++this.counters.pipeline,
          status: 'running',
          settleAt: at + PIPELINE_RUN_MS,
          finalStatus: 'success',
        };
      }
    }
    if (opts.emitEvent !== false) this.pushEvent(state, branchName, commit, !existing, at);
    state.lastActivityAt = Math.max(state.lastActivityAt, at);
    return commit;
  }

  /** FileEdits → committed changes on a branch. */
  commitEdits(
    state: RepoState,
    opts: {
      branch: string;
      startRef?: string;
      message: string;
      author: string;
      edits: Parameters<typeof applyEdits>[1];
      at?: number;
      emitEvent?: boolean;
    },
  ): CommitObj {
    this.materialize(state);
    const branch = state.branches.get(opts.branch);
    const baseSha = branch
      ? branch.head
      : this.resolveRef(state, opts.startRef ?? state.repo.defaultBranch);
    const changes = applyEdits(this.commit(state, baseSha).tree!, opts.edits);
    return this.commitChanges(state, { ...opts, changes });
  }

  createBranch(state: RepoState, name: string, ref: string): BranchObj {
    const branch = name.trim();
    if (!branch || /\s|\.\.|^\/|\/$/.test(branch)) throw badRequest(`Invalid branch name: ${name}`);
    if (state.branches.has(branch)) throw conflict(`Branch already exists: ${branch}`);
    const head = this.resolveRef(state, ref);
    const obj: BranchObj = { name: branch, head, createdAt: Date.now(), protected: false };
    state.branches.set(branch, obj);
    return obj;
  }

  createTag(state: RepoState, name: string, ref: string, message: string, author: string): TagObj {
    const tag = name.trim();
    if (!tag || /\s/.test(tag)) throw badRequest(`Invalid tag name: ${name}`);
    if (state.tags.has(tag)) throw conflict(`Tag already exists: ${tag}`);
    const target = this.resolveRef(state, ref);
    const now = Date.now();
    const obj: TagObj = { name: tag, target, message, author, createdAt: now };
    state.tags.set(tag, obj);
    this.addEvent(state, {
      action: 'pushed new',
      at: now,
      author,
      targetType: null,
      targetIid: null,
      targetTitle: null,
      push: { ref: tag, refType: 'tag', count: 0, to: target, title: message || `Tag ${tag}` },
    });
    return obj;
  }

  createMr(
    state: RepoState,
    input: {
      source_branch: string;
      target_branch?: string;
      title: string;
      description?: string;
      labels?: string[] | string;
      author?: string;
      changes?: Parameters<typeof applyEdits>[1];
      commit_message?: string;
      /** Admin merges back-date the MR. */
      at?: number;
      approvedBy?: string[];
      pipeline?: PipelineStatus;
    },
  ): MrObj {
    this.materialize(state);
    const title = input.title?.trim();
    if (!title) throw badRequest('title is required');
    const source = input.source_branch?.trim();
    if (!source) throw badRequest('source_branch is required');
    const target = input.target_branch?.trim() || state.repo.defaultBranch;
    if (!state.branches.has(target)) throw notFound(`Target branch not found: ${target}`);
    if (source === target) throw badRequest('source_branch and target_branch must differ');
    if (
      state.mrs.some(
        (m) => m.state === 'opened' && m.sourceBranch === source && m.targetBranch === target,
      )
    ) {
      throw conflict(`Another open merge request already exists for ${source} → ${target}`);
    }
    const author = input.author?.trim() || DEFAULT_AUTHOR;
    const at = input.at ?? Date.now();
    if (input.changes && input.changes.length > 0) {
      this.commitEdits(state, {
        branch: source,
        startRef: target,
        message: input.commit_message?.trim() || title,
        author,
        edits: input.changes,
        at: input.at !== undefined ? at - 3 * MINUTE : at,
      });
    } else if (!state.branches.has(source)) {
      throw badRequest(
        `Source branch ${source} does not exist. Pass \`changes\` to create it with a commit, or create the branch first.`,
      );
    }
    const head = state.branches.get(source)!.head;
    const targetHead = state.branches.get(target)!.head;
    const baseSha = this.mergeBase(state, targetHead, head);
    const baseAncestors = this.ancestors(state, baseSha);
    const commits = this.history(state, head)
      .filter((c) => !baseAncestors.has(c.sha))
      .reverse()
      .map((c) => c.sha);
    if (commits.length === 0)
      throw badRequest(`${source} has no commits that are not already in ${target}`);
    const iid = state.mrs.length + 1;
    for (const sha of commits) {
      const c = state.commits.get(sha)!;
      if (c.mrIid === null) c.mrIid = iid;
    }
    const pipeline = input.pipeline;
    const mr: MrObj = {
      id: 24_000 + ++this.counters.mr,
      iid,
      title,
      description: input.description ?? '',
      state: 'opened',
      createdAt: at,
      updatedAt: at,
      mergedAt: null,
      closedAt: null,
      author,
      mergedBy: null,
      closedBy: null,
      approvedBy: input.approvedBy ?? [],
      sourceBranch: source,
      targetBranch: target,
      labels: parseLabels(input.labels) ?? [],
      commits,
      baseSha,
      mergeCommitSha: null,
      pipeline: pipeline
        ? { id: 480_000 + ++this.counters.pipeline, status: pipeline }
        : {
            id: 480_000 + ++this.counters.pipeline,
            status: 'running',
            settleAt: at + PIPELINE_RUN_MS,
            finalStatus: 'success',
          },
      notes: [],
    };
    state.mrs.push(mr);
    this.mrEvent(state, mr, 'opened', author, at);
    return mr;
  }

  updateMr(
    state: RepoState,
    mr: MrObj,
    input: {
      title?: string;
      description?: string;
      labels?: string[] | string;
      add_labels?: string[] | string;
      remove_labels?: string[] | string;
      state_event?: 'close' | 'reopen';
      actor?: string;
    },
  ): MrObj {
    const now = Date.now();
    const actor = input.actor?.trim() || DEFAULT_AUTHOR;
    if (input.title !== undefined) {
      if (!input.title.trim()) throw badRequest('title cannot be empty');
      mr.title = input.title.trim();
    }
    if (input.description !== undefined) mr.description = input.description;
    const replace = parseLabels(input.labels);
    if (replace) mr.labels = replace;
    for (const l of parseLabels(input.add_labels) ?? [])
      if (!mr.labels.includes(l)) mr.labels.push(l);
    const remove = parseLabels(input.remove_labels) ?? [];
    mr.labels = mr.labels.filter((l) => !remove.includes(l));
    if (input.state_event === 'close') {
      if (mr.state !== 'opened') throw conflict(`Merge request !${mr.iid} is ${mr.state}`);
      mr.state = 'closed';
      mr.closedAt = now;
      mr.closedBy = actor;
      this.mrEvent(state, mr, 'closed', actor, now);
    } else if (input.state_event === 'reopen') {
      if (mr.state !== 'closed') throw conflict(`Merge request !${mr.iid} is ${mr.state}`);
      if (!state.branches.has(mr.sourceBranch)) {
        state.branches.set(mr.sourceBranch, {
          name: mr.sourceBranch,
          head: this.mrHead(mr),
          createdAt: now,
          protected: false,
        });
      }
      mr.state = 'opened';
      mr.closedAt = null;
      mr.closedBy = null;
      this.mrEvent(state, mr, 'reopened', actor, now);
    }
    mr.updatedAt = now;
    return mr;
  }

  approveMr(mr: MrObj, username: string): MrObj {
    if (mr.state !== 'opened') throw conflict(`Merge request !${mr.iid} is ${mr.state}`);
    if (!mr.approvedBy.includes(username)) mr.approvedBy.push(username);
    mr.updatedAt = Date.now();
    return mr;
  }

  mergeMr(
    state: RepoState,
    mr: MrObj,
    mergedBy: string,
    opts: { message?: string; at?: number } = {},
  ): MrObj {
    if (mr.state !== 'opened')
      throw conflict(`Merge request !${mr.iid} is ${mr.state} and cannot be merged`);
    this.materialize(state);
    const target = state.branches.get(mr.targetBranch);
    if (!target) throw conflict(`Target branch ${mr.targetBranch} no longer exists`);
    const at = opts.at ?? Date.now();
    const head = this.mrHead(mr);
    const base = this.mergeBase(state, target.head, head);
    let tree: TreeMap;
    if (base === target.head) {
      tree = this.tree(state, head);
    } else {
      const merged = threeWayMerge(
        this.tree(state, base),
        this.tree(state, target.head),
        this.tree(state, head),
      );
      if (merged.conflicts.length > 0) {
        throw conflict(
          `Merge conflict in ${merged.conflicts.join(', ')}. ${mr.targetBranch} changed the same lines; rebase ${mr.sourceBranch} onto ${mr.targetBranch}.`,
        );
      }
      tree = merged.tree;
    }
    const title = `Merge branch '${mr.sourceBranch}' into '${mr.targetBranch}'`;
    const message =
      opts.message?.trim() ||
      `${title}\n\n${mr.title}\n\nSee merge request ${state.repo.path}!${mr.iid}`;
    const merge = this.addCommitObj(state, {
      sha: this.newSha(state, target.head, message, at),
      parents: [target.head, head],
      title: message.split('\n')[0]!,
      message,
      author: mergedBy,
      authoredAt: at,
      committedAt: at,
      mrIid: mr.iid,
      tree,
    });
    target.head = merge.sha;
    mr.state = 'merged';
    mr.mergedAt = at;
    mr.mergedBy = mergedBy;
    mr.mergeCommitSha = merge.sha;
    mr.updatedAt = at;
    if (mr.pipeline.settleAt !== undefined && at < mr.pipeline.settleAt) mr.pipeline.settleAt = at;
    // GitLab's default: delete the source branch once merged.
    const source = state.branches.get(mr.sourceBranch);
    const othersUseIt = state.mrs.some(
      (m) => m !== mr && m.state === 'opened' && m.sourceBranch === mr.sourceBranch,
    );
    if (source && !source.protected && !othersUseIt && source.head === head)
      state.branches.delete(mr.sourceBranch);
    this.mrEvent(state, mr, 'merged', mergedBy, at);
    return mr;
  }

  addNote(state: RepoState, mr: MrObj, body: string, author: string, at = Date.now()): NoteObj {
    if (!body.trim()) throw badRequest('body is required');
    const note: NoteObj = {
      id: 91_000 + ++this.counters.note,
      body,
      author,
      createdAt: at,
      system: false,
    };
    mr.notes.push(note);
    mr.updatedAt = at;
    this.mrEvent(state, mr, 'commented on', author, at);
    return note;
  }

  // -------------------------------------------------------------------------
  // Simulator admin
  // -------------------------------------------------------------------------

  adminMerge(input: AdminMergeInput): { state: RepoState; mr: MrObj; merge: CommitObj } {
    const state = this.project(input.project);
    this.materialize(state);
    const now = Date.now();
    const openedAt = now - Math.max(1, input.opened_minutes_ago ?? 90) * MINUTE;
    const main = state.repo.defaultBranch;
    // Validate edits against current main before touching any state.
    const mainTree = this.tree(state, state.branches.get(main)!.head);
    const changes = effectiveChanges(mainTree, applyEdits(mainTree, input.edits));
    if (changes.size === 0)
      throw badRequest('No changes: every edit matches the current file content');
    let branch = input.source_branch?.trim() || `sim/${shaFor(String(now)).slice(0, 8)}`;
    for (let n = 2; state.branches.has(branch) || branch === main; n++)
      branch = `${input.source_branch}-${n}`;
    const mr = this.createMr(state, {
      source_branch: branch,
      target_branch: main,
      title: input.title,
      description: input.description,
      labels: input.labels,
      author: input.author,
      changes: input.edits,
      commit_message: input.title,
      at: openedAt,
      approvedBy:
        input.approvers && input.approvers.length > 0 ? input.approvers : [input.merged_by],
      pipeline: input.pipeline_status ?? 'success',
    });
    this.mergeMr(state, mr, input.merged_by, { at: now });
    return { state, mr, merge: this.commit(state, mr.mergeCommitSha!) };
  }

  adminCommit(input: AdminCommitInput): { state: RepoState; commit: CommitObj } {
    const state = this.project(input.project);
    const branch = input.branch?.trim() || state.repo.defaultBranch;
    if (!state.branches.has(branch)) throw notFound(`Branch not found: ${branch}`);
    const commit = this.commitEdits(state, {
      branch,
      message: input.message,
      author: input.author,
      edits: input.edits,
    });
    return { state, commit };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  stats() {
    let commits = 0;
    let mrs = 0;
    let open = 0;
    for (const s of this.repos.values()) {
      commits += s.commits.size;
      mrs += s.mrs.length;
      for (const m of s.mrs) if (m.state === 'opened') open++;
    }
    return { projects: this.repos.size, commits, merge_requests: mrs, open_merge_requests: open };
  }
}
