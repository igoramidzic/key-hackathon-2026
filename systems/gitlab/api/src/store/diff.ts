import type { FileDiff } from '@sim/contracts/gitlab';
import { applyPatch, structuredPatch } from 'diff';
import type { TreeMap } from './types';

/** Unified diff for one file (GitLab style: hunks only, starting at `@@`). */
export function fileDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
): FileDiff {
  const patch = structuredPatch(path, path, before ?? '', after ?? '', '', '', { context: 3 });
  let additions = 0;
  let deletions = 0;
  const parts: string[] = [];
  for (const hunk of patch.hunks) {
    // git numbers an empty side from the line before it (`@@ -0,0 +1,3 @@` for a new file).
    const oldStart = hunk.oldLines === 0 ? Math.max(0, hunk.oldStart - 1) : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? Math.max(0, hunk.newStart - 1) : hunk.newStart;
    parts.push(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
      parts.push(line);
    }
  }
  return {
    old_path: path,
    new_path: path,
    a_mode: before === undefined ? '0' : '100644',
    b_mode: after === undefined ? '0' : '100644',
    new_file: before === undefined,
    renamed_file: false,
    deleted_file: after === undefined,
    diff: parts.length > 0 ? `${parts.join('\n')}\n` : '',
    additions,
    deletions,
  };
}

/** Per-file diffs between two trees, sorted by path. */
export function diffTrees(before: TreeMap | undefined, after: TreeMap): FileDiff[] {
  const paths = new Set<string>([...(before?.keys() ?? []), ...after.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const a = before?.get(path);
    const b = after.get(path);
    if (a === b) continue;
    out.push(fileDiff(path, a, b));
  }
  return out;
}

export function diffStats(diffs: FileDiff[]) {
  const additions = diffs.reduce((n, d) => n + d.additions, 0);
  const deletions = diffs.reduce((n, d) => n + d.deletions, 0);
  return { additions, deletions, total: additions + deletions };
}

/**
 * Three-way merge of `source` into `target` given their merge base. Files changed on only one
 * side take that side; files changed on both are merged line-wise (fails on overlap).
 * Returns the merged tree, or the list of conflicting paths.
 */
export function threeWayMerge(
  base: TreeMap,
  target: TreeMap,
  source: TreeMap,
): { tree: TreeMap; conflicts: string[] } {
  const merged: TreeMap = new Map(target);
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...source.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const s = source.get(path);
    if (s === b) continue; // source did not touch it
    const t = target.get(path);
    if (t === b || t === s) {
      if (s === undefined) merged.delete(path);
      else merged.set(path, s);
      continue;
    }
    if (b === undefined || s === undefined || t === undefined) {
      conflicts.push(path);
      continue;
    }
    const patch = structuredPatch(path, path, b, s, '', '', { context: 3 });
    const result = applyPatch(t, patch);
    if (result === false) conflicts.push(path);
    else merged.set(path, result);
  }
  const sorted: TreeMap = new Map(
    [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { tree: sorted, conflicts };
}
