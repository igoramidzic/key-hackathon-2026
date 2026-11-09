import type { PipelineStatus } from '@sim/contracts/gitlab';
import type { RepoOverlay } from '@sim/scenarios';
import { type Repo, Rng, shaFor } from '@sim/world';
import {
  type BranchObj,
  type CommitObj,
  DAY,
  type EventObj,
  HOUR,
  MINUTE,
  type MrObj,
  type NoteObj,
  type RepoState,
  type TagObj,
} from '../store/types';
import {
  buildContext,
  cloneKnobs,
  initialKnobs,
  type Knobs,
  type RepoContext,
  renderTree,
  type Tree,
} from '../templates/index';
import { pickRecipe, type Recipe } from './recipes';

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Events are collected with id 0 and numbered instance-wide once every repo is planned. */
export type PlannedEvent = Omit<EventObj, 'id'>;

export interface RepoPlanOptions {
  now: number;
  overlay?: RepoOverlay;
  /** Open / closed MRs to seed in this repo (decided instance-wide). */
  openMrs: number;
  closedMrs: number;
  /** Scales generated (non-hero) repos' history length, e.g. 0.4 on memory-constrained hosts. */
  historyScale?: number;
}

export interface RepoPlan {
  state: RepoState;
  events: PlannedEvent[];
}

const TEST_COMMANDS: Record<string, string> = {
  'java-spring': '`./mvnw verify` passes',
  'node-ts': '`npm test` passes',
  python: '`pytest` passes',
  'react-web': '`npm test` passes and checked the page locally',
  terraform: '`terraform plan -var-file=envs/prod.tfvars` reviewed',
};

const REVIEW_NOTES = [
  'LGTM',
  'Looks good to me.',
  'Approved. Please keep an eye on the dashboards after the deploy.',
  'Nit: CHANGELOG wording could be tighter, otherwise good.',
  'Thanks for adding tests.',
  'Can we roll this out in the Tuesday change window?',
  'Did we confirm this with the downstream teams?',
  'Approving. Ping me if the pipeline flakes again.',
];
const AUTHOR_REPLIES = [
  'Done.',
  'Yes, confirmed in the team channel.',
  'Will do.',
  'Good call, updated.',
];

/**
 * Plans one repo's seeded history: commits (with knob mutations, rendered lazily), merged MRs,
 * releases/tags, open and closed MRs, notes, and activity events. Deterministic per repo path.
 */
export function planRepo(repo: Repo, opts: RepoPlanOptions): RepoPlan {
  const { now, overlay } = opts;
  const rng = new Rng(repo.path);
  const ctx: RepoContext = buildContext(repo);
  const app = ctx.app;
  const devs = app.developerUsernames.length > 0 ? app.developerUsernames : [app.ownerUsername];
  const reviewers = [...new Set([...devs, app.ownerUsername])];
  const hero = app.hero;
  const createdAt = now - repo.createdDaysAgo * DAY - rng.int(0, 10) * HOUR;
  const latest = hero ? now - 26 * HOUR : now - 15 * MINUTE;

  const commits = new Map<string, CommitObj>();
  const order: string[] = [];
  const branches = new Map<string, BranchObj>();
  const tags = new Map<string, TagObj>();
  const mrs: Omit<MrObj, 'iid' | 'id'>[] = [];
  const mrMergeCommits = new Map<number, CommitObj>();
  const events: PlannedEvent[] = [];
  let seq = 0;

  const k = initialKnobs(ctx, isoDate(createdAt));

  const addCommit = (c: Omit<CommitObj, 'sha' | 'seq'>): CommitObj => {
    const sha = shaFor(`${repo.path}#${seq}#${c.title}#${c.parents.join(',')}`);
    const commit: CommitObj = { ...c, sha, seq: seq++ };
    commits.set(sha, commit);
    order.push(sha);
    return commit;
  };

  const pushEvent = (e: Omit<PlannedEvent, 'repoId'>) => events.push({ ...e, repoId: repo.id });

  // Overlay repos: only accept recipes that produce a real diff outside protected files.
  let prevTree: Tree | undefined = overlay ? renderTree(ctx, k, overlay) : undefined;
  const changesTree = (mutate: (kk: Knobs) => void): Tree | null => {
    if (!overlay || !prevTree) return null;
    const kk = cloneKnobs(k);
    mutate(kk);
    const next = renderTree(ctx, kk, overlay);
    const changed = Object.keys(next).some((p) => next[p] !== prevTree![p]);
    return changed ? next : null;
  };
  const accept = (r: Recipe) => !overlay || changesTree(r.mutate) !== null;
  const exclude = overlay?.complete ? ['docs', 'test'] : [];

  let ticket = rng.int(120, 3800);
  const nextTicket = () => {
    ticket += rng.int(1, 30);
    return `${repo.tla}-${ticket}`;
  };

  const titleFor = (r: Recipe, tk: string): string => {
    if (r.kind === 'release') {
      return rng.pick([
        `chore(release): ${r.text.replace('release ', '')}`,
        cap(r.text),
        `${tk}: ${cap(r.text)}`,
      ]);
    }
    if (r.kind === 'dep') return `${r.type}(deps): ${r.text}`;
    const style = rng.weighted([
      ['ticket', 45],
      ['conventional', 40],
      ['plain', 15],
    ] as const);
    if (style === 'conventional') return `${r.type}${r.scope ? `(${r.scope})` : ''}: ${r.text}`;
    if (style === 'ticket') return `${tk}: ${cap(r.text)}`;
    return cap(r.text);
  };

  const branchFor = (r: Recipe, tk: string): string => {
    if (r.kind === 'dep') return `renovate/${r.branch.replace(/^deps\//, '')}`;
    const prefix = r.type === 'feat' ? 'feature' : r.type === 'fix' ? 'fix' : 'chore';
    return `${prefix}/${tk}-${r.branch}`;
  };

  const describe = (r: Recipe, tk: string, twoCommits: boolean): string =>
    [
      '## What',
      '',
      r.why,
      '',
      '## Changes',
      '',
      ...r.bullets.map((b) => `- ${b}`),
      ...(r.changelog ? [`- CHANGELOG: ${r.changelog}`] : []),
      ...(twoCommits ? ['- Follow-up commit with the CHANGELOG entry'] : []),
      '',
      '## Testing',
      '',
      `- [x] ${TEST_COMMANDS[repo.stack] ?? 'Tests pass'}`,
      '- [x] Deployed to DEV and smoke-tested',
      '',
      `Jira: [${tk}](https://keybank.atlassian.net/browse/${tk})`,
    ].join('\n');

  const bodyFor = (r: Recipe) => (rng.chance(0.5) ? `\n\n${r.why}` : '');

  const mrNotes = (
    author: string,
    approvers: string[],
    from: number,
    to: number,
  ): Omit<NoteObj, 'id'>[] => {
    const out: Omit<NoteObj, 'id'>[] = [];
    const count = rng.weighted([
      [0, 35],
      [1, 35],
      [2, 20],
      [3, 10],
    ] as const);
    const span = Math.max(0, to - from);
    const fractions = Array.from({ length: count }, () => rng.float(0.05, 0.95)).sort(
      (a, b) => a - b,
    );
    for (let i = 0; i < count; i++) {
      const t = from + Math.floor(span * fractions[i]!);
      const reviewerTurn = i % 2 === 0;
      const who = reviewerTurn ? (approvers[0] ?? rng.pick(reviewers)) : author;
      out.push({
        body: reviewerTurn ? rng.pick(REVIEW_NOTES) : rng.pick(AUTHOR_REPLIES),
        author: who,
        createdAt: t,
        system: false,
      });
    }
    return out;
  };

  // ----- initial commit -----
  const initialAuthor = devs[0]!;
  let main = addCommit({
    parents: [],
    title: 'Initial commit',
    message: `Initial commit\n\nImport ${repo.name} into GitLab.`,
    author: initialAuthor,
    authoredAt: createdAt,
    committedAt: createdAt,
    mrIid: null,
    seed: { kind: 'initial' },
  });
  pushEvent({
    action: 'pushed new',
    at: createdAt,
    author: initialAuthor,
    targetType: null,
    targetIid: null,
    targetTitle: null,
    push: { ref: 'main', refType: 'branch', count: 1, to: main.sha, title: main.title },
  });

  // ----- timeline -----
  const drawn = hero ? rng.int(18, 30) : rng.int(5, 30);
  const count = hero ? drawn : Math.max(3, Math.round(drawn * (opts.historyScale ?? 1)));
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const recent = rng.chance(0.55);
    const lo = recent ? Math.max(createdAt + DAY, now - 30 * DAY) : createdAt + DAY;
    const hi = recent ? latest : now - 30 * DAY;
    times.push(Math.floor(rng.float(lo, Math.max(lo + MINUTE, hi))));
  }
  times.sort((a, b) => a - b);

  const applyToMain = (mutate: (kk: Knobs) => void) => {
    mutate(k);
    if (overlay) prevTree = renderTree(ctx, k, overlay);
  };

  for (const at of times) {
    if (at <= main.committedAt + MINUTE) continue;
    const recipe = pickRecipe(rng, ctx, k, isoDate(at), accept, exclude);
    if (!recipe) continue;
    const tk = nextTicket();
    const author = rng.pick(devs);
    const title = titleFor(recipe, tk);
    const withChangelog = (kk: Knobs) => {
      recipe.mutate(kk);
      if (recipe.changelog) kk.changelog.unreleased.push(recipe.changelog);
    };

    if (!rng.chance(0.4)) {
      // Direct push to main.
      main = addCommit({
        parents: [main.sha],
        title,
        message: `${title}${bodyFor(recipe)}`,
        author,
        authoredAt: at,
        committedAt: at,
        mrIid: null,
        seed: { kind: 'change', mutate: withChangelog },
      });
      applyToMain(withChangelog);
      pushEvent({
        action: 'pushed to',
        at,
        author,
        targetType: null,
        targetIid: null,
        targetTitle: null,
        push: { ref: 'main', refType: 'branch', count: 1, to: main.sha, title },
      });
    } else {
      // Merge request: 1-2 source commits, then a merge commit on main.
      const mrIndex = mrs.length;
      const twoCommits = recipe.changelog !== null && rng.chance(0.35);
      const prevAt = main.committedAt;
      let openedAt = at - rng.int(20, 72 * 60) * MINUTE;
      if (openedAt <= prevAt + 2 * MINUTE) openedAt = prevAt + Math.floor((at - prevAt) / 2);
      const firstAt = Math.max(prevAt + MINUTE, openedAt - rng.int(1, 30) * MINUTE);
      const branch = branchFor(recipe, tk);
      const src1 = addCommit({
        parents: [main.sha],
        title,
        message: `${title}${bodyFor(recipe)}`,
        author,
        authoredAt: firstAt,
        committedAt: firstAt,
        mrIid: mrIndex,
        seed: { kind: 'change', mutate: twoCommits ? recipe.mutate : withChangelog },
      });
      const sources = [src1];
      if (twoCommits) {
        const secondAt = openedAt + Math.floor((at - openedAt) * rng.float(0.2, 0.8));
        const entry = recipe.changelog!;
        sources.push(
          addCommit({
            parents: [src1.sha],
            title: rng.pick(['Add CHANGELOG entry', 'Address review feedback', 'Update CHANGELOG']),
            message: 'Add CHANGELOG entry',
            author,
            authoredAt: secondAt,
            committedAt: secondAt,
            mrIid: mrIndex,
            seed: {
              kind: 'change',
              mutate: (kk) => {
                kk.changelog.unreleased.push(entry);
              },
            },
          }),
        );
      }
      const head = sources[sources.length - 1]!;
      const others = reviewers.filter((u) => u !== author);
      const mergedBy = others.length > 0 ? rng.pick(others) : author;
      const approvers = rng.pickN(others.length > 0 ? others : [author], rng.int(1, 2));
      if (!approvers.includes(mergedBy) && rng.chance(0.6)) approvers.push(mergedBy);
      const merge = addCommit({
        parents: [main.sha, head.sha],
        title: `Merge branch '${branch}' into 'main'`,
        message: '',
        author: mergedBy,
        authoredAt: at,
        committedAt: at,
        mrIid: mrIndex,
        seed: { kind: 'merge' },
      });
      mrMergeCommits.set(mrIndex, merge);
      const baseSha = main.sha;
      main = merge;
      applyToMain(withChangelog);
      mrs.push({
        title:
          rng.chance(0.15) && !title.startsWith('chore')
            ? `${title} (${tk})`.replace(`${tk}: `, '')
            : title,
        description: describe(recipe, tk, twoCommits),
        state: 'merged',
        createdAt: openedAt,
        updatedAt: at,
        mergedAt: at,
        closedAt: null,
        author,
        mergedBy,
        closedBy: null,
        approvedBy: approvers,
        sourceBranch: branch,
        targetBranch: 'main',
        labels: recipe.labels,
        commits: sources.map((s) => s.sha),
        baseSha,
        mergeCommitSha: merge.sha,
        pipeline: { id: 0, status: 'success' },
        notes: mrNotes(author, approvers, openedAt, at).map((n) => ({ ...n, id: 0 })),
      });
      for (const [i, s] of sources.entries()) {
        pushEvent({
          action: i === 0 ? 'pushed new' : 'pushed to',
          at: s.committedAt,
          author,
          targetType: null,
          targetIid: null,
          targetTitle: null,
          push: { ref: branch, refType: 'branch', count: 1, to: s.sha, title: s.title },
        });
      }
    }

    if (recipe.tag && !tags.has(recipe.tag)) {
      const tagAt = main.committedAt + rng.int(1, 30) * MINUTE;
      const tagAuthor = main.author;
      tags.set(recipe.tag, {
        name: recipe.tag,
        target: main.sha,
        message: `Release ${recipe.tag}`,
        author: tagAuthor,
        createdAt: Math.min(tagAt, latest),
      });
      pushEvent({
        action: 'pushed new',
        at: Math.min(tagAt, latest),
        author: tagAuthor,
        targetType: null,
        targetIid: null,
        targetTitle: null,
        push: {
          ref: recipe.tag,
          refType: 'tag',
          count: 0,
          to: main.sha,
          title: `Release ${recipe.tag}`,
        },
      });
    }
  }

  branches.set('main', { name: 'main', head: main.sha, createdAt, protected: true });

  // ----- open and closed MRs (branch from the current main head) -----
  const extra = [
    ...Array.from({ length: opts.openMrs }, () => 'opened' as const),
    ...Array.from({ length: opts.closedMrs }, () => 'closed' as const),
  ];
  for (const state of extra) {
    const baseKnobs = cloneKnobs(k);
    const recipe = pickRecipe(rng, ctx, baseKnobs, isoDate(latest), accept, [
      ...exclude,
      'release',
    ]);
    if (!recipe) continue;
    const lo = Math.max(main.committedAt + 5 * MINUTE, now - (state === 'opened' ? 10 : 20) * DAY);
    const openedAt = Math.floor(lo < latest ? rng.float(lo, latest) : latest - MINUTE);
    const tk = nextTicket();
    const author = rng.pick(devs);
    const title = titleFor(recipe, tk);
    const branch = branchFor(recipe, tk);
    if (branches.has(branch)) continue;
    const mrIndex = mrs.length;
    const src = addCommit({
      parents: [main.sha],
      title,
      message: `${title}${bodyFor(recipe)}`,
      author,
      authoredAt: openedAt - rng.int(1, 20) * MINUTE,
      committedAt: openedAt - rng.int(0, 1) * MINUTE,
      mrIid: mrIndex,
      seed: {
        kind: 'change',
        mutate: (kk) => {
          recipe.mutate(kk);
          if (recipe.changelog) kk.changelog.unreleased.push(recipe.changelog);
        },
      },
    });
    const others = reviewers.filter((u) => u !== author);
    let closedAt: number | null = null;
    if (state === 'closed') {
      closedAt = openedAt + rng.int(30, 3 * 24 * 60) * MINUTE;
      if (closedAt > latest)
        closedAt = Math.floor(
          rng.float(openedAt + MINUTE, Math.max(openedAt + 2 * MINUTE, latest)),
        );
    }
    const end = closedAt ?? latest;
    const recentlyOpened = now - openedAt < 2 * HOUR;
    const status: PipelineStatus =
      state === 'closed'
        ? rng.pick(['failed', 'canceled', 'success'] as const)
        : rng.weighted([
            ['success', 75],
            ['failed', 15],
            [recentlyOpened ? 'running' : 'success', 10],
          ] as const);
    const approvers =
      state === 'opened' && rng.chance(0.4) && others.length > 0 ? [rng.pick(others)] : [];
    mrs.push({
      title: state === 'opened' && rng.chance(0.12) ? `Draft: ${title}` : title,
      description: describe(recipe, tk, false),
      state,
      createdAt: openedAt,
      updatedAt: closedAt ?? openedAt + Math.floor((end - openedAt) * rng.float(0, 0.5)),
      mergedAt: null,
      closedAt,
      author,
      mergedBy: null,
      closedBy: closedAt ? author : null,
      approvedBy: approvers,
      sourceBranch: branch,
      targetBranch: 'main',
      labels: recipe.labels,
      commits: [src.sha],
      baseSha: main.sha,
      mergeCommitSha: null,
      pipeline: { id: 0, status },
      notes: mrNotes(author, others.slice(0, 1), openedAt, end).map((n) => ({ ...n, id: 0 })),
    });
    if (state === 'opened') {
      branches.set(branch, {
        name: branch,
        head: src.sha,
        createdAt: src.committedAt,
        protected: false,
      });
    }
    pushEvent({
      action: 'pushed new',
      at: src.committedAt,
      author,
      targetType: null,
      targetIid: null,
      targetTitle: null,
      push: { ref: branch, refType: 'branch', count: 1, to: src.sha, title },
    });
  }

  // ----- assign iids by creation time; fill merge commit messages; MR events -----
  const sortedIdx = mrs.map((_, i) => i).sort((a, b) => mrs[a]!.createdAt - mrs[b]!.createdAt);
  const iidOf = new Map<number, number>();
  sortedIdx.forEach((idx, pos) => {
    iidOf.set(idx, pos + 1);
  });
  for (const c of commits.values()) {
    if (c.mrIid !== null) c.mrIid = iidOf.get(c.mrIid)!;
  }
  const finalMrs: MrObj[] = sortedIdx.map((idx) => ({ ...mrs[idx]!, id: 0, iid: iidOf.get(idx)! }));
  for (const [idx, merge] of mrMergeCommits) {
    const mr = mrs[idx]!;
    merge.message = `${merge.title}\n\n${mr.title}\n\nSee merge request ${repo.path}!${iidOf.get(idx)}`;
  }
  for (const mr of finalMrs) {
    pushEvent({
      action: 'opened',
      at: mr.createdAt,
      author: mr.author,
      targetType: 'MergeRequest',
      targetIid: mr.iid,
      targetTitle: mr.title,
      push: null,
    });
    if (mr.mergedAt && mr.mergedBy) {
      pushEvent({
        action: 'merged',
        at: mr.mergedAt,
        author: mr.mergedBy,
        targetType: 'MergeRequest',
        targetIid: mr.iid,
        targetTitle: mr.title,
        push: null,
      });
    }
    if (mr.closedAt && mr.closedBy) {
      pushEvent({
        action: 'closed',
        at: mr.closedAt,
        author: mr.closedBy,
        targetType: 'MergeRequest',
        targetIid: mr.iid,
        targetTitle: mr.title,
        push: null,
      });
    }
    for (const note of mr.notes) {
      pushEvent({
        action: 'commented on',
        at: note.createdAt,
        author: note.author,
        targetType: 'MergeRequest',
        targetIid: mr.iid,
        targetTitle: mr.title,
        push: null,
      });
    }
  }

  const lastActivityAt = events.reduce((max, e) => Math.max(max, e.at), createdAt);
  return {
    state: {
      repo,
      app,
      ctx,
      overlay,
      createdAt,
      commits,
      order,
      branches,
      tags,
      mrs: finalMrs,
      materialized: false,
      lastActivityAt,
    },
    events,
  };
}
