import { badRequest, HttpError, notFound } from '@sim/api-kit';
import type { FileEdit } from '@sim/contracts/gitlab';
import { normalizePath } from '../templates/index';
import type { TreeMap } from './types';

export const unprocessable = (message: string) => new HttpError(422, message);

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * Applies FileEdits (full content or find/replace) to a tree. Returns the changed files
 * (path → new content); the input tree is not modified. Edits apply in order, so several edits
 * may target the same file. A `find` must occur exactly once (422 otherwise).
 */
export function applyEdits(tree: TreeMap, edits: FileEdit[]): Map<string, string> {
  if (!Array.isArray(edits) || edits.length === 0)
    throw badRequest('At least one edit is required');
  const changes = new Map<string, string>();
  const current = (path: string) => (changes.has(path) ? changes.get(path) : tree.get(path));
  for (const edit of edits) {
    if (!edit || typeof edit.path !== 'string' || !edit.path.trim()) {
      throw badRequest('Each edit needs a path');
    }
    const path = normalizePath(edit.path.trim());
    if (path.split('/').some((seg) => seg === '..' || seg === '')) {
      throw badRequest(`Invalid path: ${edit.path}`);
    }
    if (typeof edit.content === 'string') {
      changes.set(path, edit.content);
      continue;
    }
    if (typeof edit.find === 'string') {
      const existing = current(path);
      if (existing === undefined)
        throw unprocessable(`Cannot apply find/replace: ${path} does not exist`);
      const n = countOccurrences(existing, edit.find);
      if (n !== 1) {
        throw unprocessable(
          n === 0
            ? `find text not found in ${path}`
            : `find text occurs ${n} times in ${path}; it must match exactly once (include more context)`,
        );
      }
      const replace = typeof edit.replace === 'string' ? edit.replace : '';
      const at = existing.indexOf(edit.find);
      changes.set(path, existing.slice(0, at) + replace + existing.slice(at + edit.find.length));
      continue;
    }
    throw badRequest(`Edit for ${path} needs either content or find/replace`);
  }
  return changes;
}

/** Changes that actually differ from the tree. */
export function effectiveChanges(tree: TreeMap, changes: Map<string, string | null>) {
  const out = new Map<string, string | null>();
  for (const [path, content] of changes) {
    if (content === null ? tree.has(path) : tree.get(path) !== content) out.set(path, content);
  }
  return out;
}

export function withChanges(tree: TreeMap, changes: Map<string, string | null>): TreeMap {
  const next: TreeMap = new Map(tree);
  for (const [path, content] of changes) {
    if (content === null) next.delete(path);
    else next.set(path, content);
  }
  return new Map([...next.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function requireFile(tree: TreeMap, path: string): string {
  const content = tree.get(normalizePath(path));
  if (content === undefined) throw notFound(`File not found: ${path}`);
  return content;
}
