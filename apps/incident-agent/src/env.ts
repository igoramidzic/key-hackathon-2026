/**
 * Loads `apps/incident-agent/.env` (gitignored) into process.env, never overriding variables that
 * are already set. Lines are KEY=VALUE; `#` starts a comment; values may be quoted.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENV_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.env',
);

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]!] = value;
  }
  return out;
}

/** Returns the names it set (never the values). */
export function loadDotEnv(
  file = DEFAULT_ENV_FILE,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!existsSync(file)) return [];
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    set.push(key);
  }
  return set;
}
