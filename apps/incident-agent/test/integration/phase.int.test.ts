/**
 * Integration: a toy phase against the running world with a real model. Skipped without
 * ANTHROPIC_API_KEY (and needs `pnpm dev`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config';
import { ClaudeProvider } from '../../src/phases/claude';
import { PhaseRunner } from '../../src/phases/runner';

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasKey)('toy phase against the running world', () => {
  it('lists the services that logged errors in the last 15 minutes', async () => {
    const config = loadConfig();
    const runner = new PhaseRunner({
      provider: new ClaudeProvider(config.mcp),
      dataDir: mkdtempSync(path.join(tmpdir(), 'agent-int-')),
      model: config.llm.model,
      deepModel: config.llm.deepModel,
    });
    const out = await runner.run({
      name: 'toy',
      system: 'You are a read-only SRE investigator. Use the tools, then answer with JSON only.',
      prompt:
        'Which services logged errors (severity ERROR or higher) in the last 15 minutes? ' +
        'Use summarize_errors. Answer with {"services": [{"service": string, "app_tla": string, "count": number}]}.',
      tools: ['summarize_errors'],
      schema: z.object({
        services: z.array(
          z.object({ service: z.string(), app_tla: z.string(), count: z.number() }),
        ),
      }),
      maxTurns: 6,
      timeoutMs: 120_000,
    });
    expect(out.ok, out.ok ? '' : out.error).toBe(true);
  }, 180_000);
});
