/**
 * Idempotent creation. Every create in the agent goes through this:
 *   1. the case already records it            → use that
 *   2. the world already has it (natural key) → adopt it (we crashed between create and save)
 *   3. otherwise                              → create it
 * and records the result on the case before anything else happens.
 *
 * Natural keys: incident by the correlation id in its description, channel by name, MR by source
 * branch, change request by related incident + MR.
 */
export type EnsureHow = 'existing' | 'found' | 'created';

export interface EnsureOptions<T> {
  current: () => T | null | undefined;
  lookup: () => Promise<T | null | undefined>;
  create: () => Promise<T>;
  record: (value: T, how: EnsureHow) => void;
}

export async function ensureOnce<T>(opts: EnsureOptions<T>): Promise<{ value: T; how: EnsureHow }> {
  const current = opts.current();
  if (current) return { value: current, how: 'existing' };
  const found = await opts.lookup();
  if (found) {
    opts.record(found, 'found');
    return { value: found, how: 'found' };
  }
  const created = await opts.create();
  opts.record(created, 'created');
  return { value: created, how: 'created' };
}
