import { isoDate } from '../history/plan';
import { cloneKnobs, initialKnobs, type Knobs, renderTree, type Tree } from '../templates/index';
import type { RepoState, TreeMap } from './types';

/** Builds a sorted tree map, reusing the parent's string instances for unchanged files. */
export function toTreeMap(rendered: Tree, parent?: TreeMap): TreeMap {
  const out: TreeMap = new Map();
  for (const path of Object.keys(rendered).sort()) {
    const content = rendered[path]!;
    const prev = parent?.get(path);
    out.set(path, prev !== undefined && prev === content ? prev : content);
  }
  return out;
}

function sameTree(a: TreeMap, b: TreeMap | undefined): boolean {
  if (!b || a.size !== b.size) return false;
  for (const [path, content] of a) if (b.get(path) !== content) return false;
  return true;
}

/**
 * Renders every seeded commit of a repo from its knob history (once, on first access).
 * Runtime commits are only ever created after this ran, so they already carry trees.
 */
export function materialize(state: RepoState): void {
  if (state.materialized) return;
  const knobs = new Map<string, Knobs>();
  const createdDate = isoDate(state.createdAt);
  for (const sha of state.order) {
    const commit = state.commits.get(sha)!;
    if (commit.tree) continue;
    const seed = commit.seed ?? { kind: 'change' as const };
    const parent = commit.parents[0] ? state.commits.get(commit.parents[0]) : undefined;
    let k: Knobs;
    if (seed.kind === 'initial') {
      k = initialKnobs(state.ctx, createdDate);
    } else if (seed.kind === 'merge') {
      k = knobs.get(commit.parents[1]!)!;
    } else {
      k = cloneKnobs(knobs.get(commit.parents[0]!)!);
      seed.mutate?.(k);
    }
    let tree = toTreeMap(renderTree(state.ctx, k, state.overlay), parent?.tree);
    if (seed.kind === 'change' && sameTree(tree, parent?.tree) && !state.overlay) {
      // Safety net: never leave an empty seeded commit.
      k.changelog.unreleased.push(`${commit.title}.`);
      tree = toTreeMap(renderTree(state.ctx, k, state.overlay), parent?.tree);
    }
    knobs.set(sha, k);
    commit.tree = tree;
  }
  state.materialized = true;
}
