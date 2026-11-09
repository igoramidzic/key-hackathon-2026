import type { EventAction, PipelineStatus } from '@sim/contracts/gitlab';
import type { RepoOverlay } from '@sim/scenarios';
import type { App, Repo } from '@sim/world';
import type { Knobs, RepoContext } from '../templates/index';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** path → file content */
export type TreeMap = Map<string, string>;

export interface SeedInfo {
  kind: 'initial' | 'change' | 'merge';
  /** Knob mutation applied on top of the first parent's knobs (change commits). */
  mutate?: (k: Knobs) => void;
}

export interface CommitObj {
  sha: string;
  parents: string[];
  title: string;
  message: string;
  author: string;
  authoredAt: number;
  committedAt: number;
  /** MR this commit belongs to (source commit or merge commit). */
  mrIid: number | null;
  /** Creation order within the repo (tie-breaker for equal timestamps). */
  seq: number;
  /** Seeded commits are rendered from knobs on first access. */
  seed?: SeedInfo;
  /** Full file tree at this commit (filled when the repo is materialized). */
  tree?: TreeMap;
}

export interface BranchObj {
  name: string;
  head: string;
  createdAt: number;
  protected: boolean;
}

export interface TagObj {
  name: string;
  target: string;
  message: string;
  author: string;
  createdAt: number;
}

export interface NoteObj {
  id: number;
  body: string;
  author: string;
  createdAt: number;
  system: boolean;
}

export interface PipelineObj {
  id: number;
  status: PipelineStatus;
  /** For MRs opened at runtime: the pipeline reports `running` until this time. */
  settleAt?: number;
  /** Status once settled. */
  finalStatus?: PipelineStatus;
}

export interface MrObj {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged';
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  closedAt: number | null;
  author: string;
  mergedBy: string | null;
  closedBy: string | null;
  approvedBy: string[];
  sourceBranch: string;
  targetBranch: string;
  labels: string[];
  /** Source commits, oldest first. */
  commits: string[];
  /** Branch point on the target branch. */
  baseSha: string;
  mergeCommitSha: string | null;
  pipeline: PipelineObj;
  notes: NoteObj[];
}

export interface RepoState {
  repo: Repo;
  app: App;
  ctx: RepoContext;
  overlay: RepoOverlay | undefined;
  createdAt: number;
  commits: Map<string, CommitObj>;
  /** Commit shas in creation order (parents always before children). */
  order: string[];
  branches: Map<string, BranchObj>;
  tags: Map<string, TagObj>;
  /** Indexed by iid - 1. */
  mrs: MrObj[];
  materialized: boolean;
  lastActivityAt: number;
}

export interface EventObj {
  id: number;
  action: EventAction;
  at: number;
  author: string;
  repoId: number;
  targetType: 'MergeRequest' | 'Note' | 'Tag' | null;
  targetIid: number | null;
  targetTitle: string | null;
  push: {
    ref: string;
    refType: 'branch' | 'tag';
    count: number;
    to: string;
    title: string;
  } | null;
}

/** Monotonic id counters shared by the whole instance. */
export interface Counters {
  mr: number;
  note: number;
  pipeline: number;
  event: number;
  commit: number;
}
