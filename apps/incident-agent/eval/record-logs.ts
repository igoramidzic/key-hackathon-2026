/**
 * Records WARNING+ log entries from the running world into a gzipped detector fixture.
 *
 *   tsx eval/record-logs.ts --since 15m --out test/fixtures/background.json.gz
 *   tsx eval/record-logs.ts --from 2026-11-11T19:00:00Z --until 2026-11-11T19:12:00Z --out …
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { LogEntry, LogSearchResult } from '@sim/contracts/logs';
import { loadConfig } from '../src/config';
import { type MiniEntry, toMini } from '../src/watchers/detector';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

export async function recordLogs(opts: {
  logsApi: string;
  since: string;
  until?: string;
}): Promise<MiniEntry[]> {
  const out: LogEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams({
      since: opts.since,
      severity: 'WARNING',
      order: 'asc',
      limit: '500',
    });
    if (opts.until) params.set('until', opts.until);
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${opts.logsApi}/api/logs?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as LogSearchResult;
    out.push(...body.items);
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return out.map(toMini);
}

async function main() {
  const config = loadConfig();
  const target = flag('out');
  if (!target) throw new Error('--out <file.json.gz> is required');
  const entries = await recordLogs({
    logsApi: config.logsApi,
    since: flag('from') ?? flag('since') ?? '15m',
    until: flag('until'),
  });
  writeFileSync(target, gzipSync(JSON.stringify(entries)));
  const first = entries[0]?.timestamp;
  const last = entries.at(-1)?.timestamp;
  console.log(`${entries.length} entries ${first} → ${last} written to ${target}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
