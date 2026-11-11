/** Loads recorded detector fixtures (see eval/record-logs.ts and eval/record-scenario.ts). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { MiniEntry } from '../src/watchers/detector';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface Fixture {
  meta: { scenario?: string; speed?: number; started_at?: string; fault_onset_at?: string | null };
  entries: MiniEntry[];
}

export function loadFixture(name: string): Fixture {
  const raw = JSON.parse(gunzipSync(readFileSync(path.join(DIR, name))).toString());
  return Array.isArray(raw) ? { meta: {}, entries: raw } : raw;
}

/** Splits a fixture into the first `learnSec` (baseline) and the rest (replay). */
export function split(entries: MiniEntry[], learnSec = 300) {
  const t0 = Date.parse(entries[0]!.timestamp);
  const cut = t0 + learnSec * 1000;
  return {
    learn: entries.filter((e) => Date.parse(e.timestamp) < cut),
    replay: entries.filter((e) => Date.parse(e.timestamp) >= cut),
  };
}
