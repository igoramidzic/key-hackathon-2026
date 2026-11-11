/**
 * The agent must find root causes from logs, ServiceNow and GitLab, never from the answer key.
 * Biome blocks the imports (see the override in biome.json); this test also catches string
 * references to the simulator API that an import rule can't see. `eval/` is exempt.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const FORBIDDEN: [RegExp, string][] = [
  [/:4000\b/, 'the simulator API port'],
  [/\/api\/scenarios/, 'the scenario answer key endpoint'],
  [/@sim\/scenarios/, 'the scenario package'],
  [/packages\/scenarios/, 'the scenario package'],
  [/@sim\/contracts\/simulator/, 'the simulator client'],
  [/@sim\/simulator/, 'the simulator app'],
  [/@sim\/world/, 'the seeded world (use the CMDB over MCP instead)'],
];

describe('answer-key guard', () => {
  const sources = files(SRC);

  it('finds the agent sources', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const file of sources) {
    it(`${path.relative(SRC, file)} does not touch the answer key`, () => {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, what] of FORBIDDEN) {
        expect(pattern.test(text), `${path.relative(SRC, file)} references ${what}`).toBe(false);
      }
    });
  }
});
