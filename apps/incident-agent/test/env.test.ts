import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv, parseEnv } from '../src/env';

describe('.env loading', () => {
  it('parses keys, quotes, comments and export', () => {
    expect(
      parseEnv(
        '# creds\nANTHROPIC_API_KEY=sk-x\nexport AGENT_SPEED=4 # fast\nQUOTED="a b"\nbad line\n',
      ),
    ).toEqual({ ANTHROPIC_API_KEY: 'sk-x', AGENT_SPEED: '4', QUOTED: 'a b' });
  });

  it('never overrides what is already set and reports only names', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'env-')), '.env');
    writeFileSync(file, 'AGENT_LLM=off\nAGENT_SPEED=4\n');
    const env: Record<string, string | undefined> = { AGENT_LLM: 'claude' };
    expect(loadDotEnv(file, env)).toEqual(['AGENT_SPEED']);
    expect(env).toEqual({ AGENT_LLM: 'claude', AGENT_SPEED: '4' });
    expect(loadDotEnv(path.join(path.dirname(file), 'missing.env'), env)).toEqual([]);
  });
});
