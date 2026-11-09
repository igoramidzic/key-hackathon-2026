import { ORG } from './constants';
import { buildWorld } from './generate';
import type { App, Person, Repo, SupportGroup, World } from './types';

export * from './constants';
export { HERO_APPS, HERO_TLAS } from './hero';
export * from './incidents';
export * from './random';
export type * from './types';

let cached: World | null = null;

/** The deterministic simulated world. Built once per process; never mutate it. */
export function getWorld(): World {
  if (!cached) cached = buildWorld();
  return cached;
}

export function getApp(tla: string): App {
  const app = getWorld().appsByTla.get(tla.toUpperCase());
  if (!app) throw new Error(`Unknown app TLA: ${tla}`);
  return app;
}

export function getPerson(username: string): Person {
  const person = getWorld().peopleByUsername.get(username);
  if (!person) throw new Error(`Unknown username: ${username}`);
  return person;
}

export function getGroup(id: string): SupportGroup {
  const group = getWorld().groupsById.get(id);
  if (!group) throw new Error(`Unknown support group: ${id}`);
  return group;
}

export function getRepo(path: string): Repo {
  const repo = getWorld().reposByPath.get(path);
  if (!repo) throw new Error(`Unknown repo: ${path}`);
  return repo;
}

/** `keybank/PAY00` for `PAY`. */
export function groupPathForTla(tla: string): string {
  return `${ORG.slug}/${tla.toUpperCase()}00`;
}

/**
 * Walks the dependency graph from `tla`. `up` follows what the app calls, `down` follows its
 * callers. Returns TLAs with their distance, excluding the start.
 */
export function dependencyClosure(
  tla: string,
  direction: 'up' | 'down',
  maxDepth = 10,
): { tla: string; depth: number }[] {
  const world = getWorld();
  const seen = new Map<string, number>();
  let frontier = [tla.toUpperCase()];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      const app = world.appsByTla.get(current);
      if (!app) continue;
      for (const neighbor of direction === 'up' ? app.upstream : app.downstream) {
        if (seen.has(neighbor) || neighbor === tla) continue;
        seen.set(neighbor, depth);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return [...seen.entries()].map(([t, depth]) => ({ tla: t, depth }));
}
