import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildClaudeOptions } from '../src/phases/claude';
import type { LlmProvider, ProviderRequest, ProviderResponse } from '../src/phases/provider';
import { emptyUsage } from '../src/phases/provider';
import {
  assertReadOnly,
  extractJson,
  PhaseRunner,
  PhaseToolError,
  toolGuard,
} from '../src/phases/runner';

const Answer = z.object({ services: z.array(z.string()), total: z.number() });

class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  requests: ProviderRequest[] = [];
  constructor(private readonly answers: ((req: ProviderRequest) => Partial<ProviderResponse>)[]) {}
  async run(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    const next = this.answers[this.requests.length - 1] ?? (() => ({ text: '' }));
    const out = next(req);
    req.onMessage({ type: 'assistant', text: out.text ?? '' });
    return { text: '', usage: { ...emptyUsage(), turns: 1, outputTokens: 10 }, ...out };
  }
}

const dataDir = () => mkdtempSync(path.join(tmpdir(), 'agent-runner-'));

function runner(provider: LlmProvider, dir = dataDir()) {
  return new PhaseRunner({ provider, dataDir: dir, model: 'fast-model', deepModel: 'deep-model' });
}

describe('PhaseRunner', () => {
  it('returns schema-valid structured output and saves a transcript', async () => {
    const dir = dataDir();
    const provider = new FakeProvider([
      () => ({ output: { services: ['payments-api'], total: 3 } }),
    ]);
    const out = await runner(provider, dir).run({
      name: 'toy',
      caseId: 'case-1',
      system: 's',
      prompt: 'p',
      tools: ['summarize_errors'],
      schema: Answer,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.total).toBe(3);
    expect(out.usage.turns).toBe(1);
    expect(out.transcripts[0]).toBe(path.join(dir, 'cases', 'case-1', 'toy-1.jsonl'));
    const lines = readFileSync(out.transcripts[0]!, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]!).type).toBe('phase_start');
    expect(JSON.parse(lines.at(-1)!).type).toBe('phase_result');
    expect(provider.requests[0]!.model).toBe('fast-model');
    expect(provider.requests[0]!.jsonSchema).toMatchObject({ type: 'object' });
  });

  it('extracts JSON from text and retries once with the validation error', async () => {
    const provider = new FakeProvider([
      () => ({ text: 'Here you go: {"services": "payments-api"}' }),
      () => ({ text: '```json\n{"services": ["payments-api"], "total": 1}\n```' }),
    ]);
    const out = await runner(provider).run({
      name: 'toy',
      system: 's',
      prompt: 'p',
      tools: ['summarize_errors'],
      schema: Answer,
    });
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(2);
    expect(provider.requests[1]!.prompt).toContain('rejected');
    expect(provider.requests[1]!.prompt).toContain('services');
  });

  it('fails after the retry when the answer is still invalid', async () => {
    const provider = new FakeProvider([() => ({ text: 'no idea' }), () => ({ text: '{}' })]);
    const out = await runner(provider).run({
      name: 'toy',
      system: 's',
      prompt: 'p',
      tools: ['search_logs'],
      schema: Answer,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('schema');
  });

  it('does not retry provider failures', async () => {
    const provider = new FakeProvider([() => ({ error: 'error_max_turns' })]);
    const out = await runner(provider).run({
      name: 'toy',
      system: 's',
      prompt: 'p',
      tools: ['search_logs'],
      schema: Answer,
    });
    expect(out.ok).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it('uses the deep model when asked', async () => {
    const provider = new FakeProvider([() => ({ output: { services: [], total: 0 } })]);
    const r = runner(provider);
    await r.run({
      name: 'rca',
      system: 's',
      prompt: 'p',
      tools: [],
      schema: Answer,
      model: r.models.deep,
    });
    expect(provider.requests[0]!.model).toBe('deep-model');
  });
});

describe('read-only phases', () => {
  it('refuses to start a phase that asks for a write tool', async () => {
    expect(() => assertReadOnly('triage', ['search_logs', 'create_incident'])).toThrow(
      PhaseToolError,
    );
    const provider = new FakeProvider([]);
    await expect(
      runner(provider).run({
        name: 'triage',
        system: 's',
        prompt: 'p',
        tools: ['search_logs', 'create_incident'],
        schema: Answer,
      }),
    ).rejects.toThrow(/create_incident/);
    expect(provider.requests).toHaveLength(0);
  });

  it('a phase given only read tools cannot call create_incident', async () => {
    let attempted: boolean | undefined;
    const provider = new FakeProvider([
      (req) => {
        // The model tries to open an incident on its own.
        attempted = req.guard('mcp__servicenow__create_incident');
        return { output: { services: [], total: 0 } };
      },
    ]);
    await runner(provider).run({
      name: 'triage',
      system: 's',
      prompt: 'p',
      tools: ['search_logs', 'get_app'],
      schema: Answer,
    });
    expect(attempted).toBe(false);

    const guard = toolGuard(['search_logs']);
    expect(guard('mcp__logs__search_logs')).toBe(true);
    expect(guard('mcp__logs__summarize_errors')).toBe(false);
    expect(guard('mcp__teams__post_message')).toBe(false);
    expect(guard('Bash')).toBe(false);
  });

  it('configures the Claude Agent SDK with reads allowed and writes removed', async () => {
    const req: ProviderRequest = {
      phase: 'triage',
      system: 'sys',
      prompt: 'p',
      model: 'claude-sonnet-5-5',
      tools: ['search_logs', 'get_app'],
      jsonSchema: { type: 'object' },
      maxTurns: 7,
      signal: new AbortController().signal,
      guard: toolGuard(['search_logs', 'get_app']),
      onMessage: () => {},
    };
    const urls = {
      logs: 'http://l/mcp',
      servicenow: 'http://s/mcp',
      gitlab: 'http://g/mcp',
      teams: 'http://t/mcp',
    };
    const opts = buildClaudeOptions(req, urls, new AbortController());
    expect(opts.tools).toEqual([]);
    expect(opts.permissionMode).toBe('dontAsk');
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.allowedTools).toEqual(['mcp__logs__search_logs', 'mcp__servicenow__get_app']);
    expect(opts.disallowedTools).toContain('mcp__servicenow__create_incident');
    expect(opts.disallowedTools).toContain('mcp__teams__post_message');
    expect(opts.disallowedTools).toContain('mcp__gitlab__create_merge_request');
    expect(opts.maxTurns).toBe(7);
    expect(opts.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    const decision = await opts.canUseTool!('mcp__servicenow__create_incident', {}, {
      signal: new AbortController().signal,
    } as never);
    expect(decision?.behavior).toBe('deny');
  });
});

describe('extractJson', () => {
  it('finds JSON in fences and prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('The answer is {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(extractJson('nothing here')).toBeUndefined();
  });
});
