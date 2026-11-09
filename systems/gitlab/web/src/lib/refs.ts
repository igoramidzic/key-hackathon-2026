import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Splits a `<ref>/<path>` splat (refs may contain slashes) using the project's branches and
 * tags; the longest matching ref wins. Falls back to the first segment (e.g. a sha).
 */
export function splitRefPath(splat: string, refs: string[]): { ref: string; path: string } {
  const decoded = splat
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
  const match = refs
    .filter((r) => decoded === r || decoded.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { ref: match, path: decoded.slice(match.length + 1) };
  const [first, ...rest] = decoded.split('/');
  return { ref: first || 'main', path: rest.join('/') };
}

export function useRefs(project: string) {
  return useQuery({
    queryKey: ['refs', project],
    queryFn: async () => {
      const [branches, tags] = await Promise.all([
        api.listBranches(project, { limit: 100 }),
        api.listTags(project, { limit: 100 }),
      ]);
      return { branches: branches.items, tags: tags.items };
    },
    staleTime: 5_000,
  });
}

/** Resolves the current ref + path from a route splat. `ready` is false until refs load. */
export function useRefPath(project: string, splat: string) {
  const refs = useRefs(project);
  const names = [
    ...(refs.data?.branches.map((b) => b.name) ?? []),
    ...(refs.data?.tags.map((t) => t.name) ?? []),
  ];
  return { ...splitRefPath(splat, names), ready: refs.isSuccess || refs.isError, refs: refs.data };
}
