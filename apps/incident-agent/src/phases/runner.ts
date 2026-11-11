/**
 * Runs one LLM "phase" (triage, RCA, fix, …): a read-only investigator that must return JSON
 * matching a zod schema. The runner enforces the read-only tool allowlist, the turn and
 * wall-clock budget, validates the answer (retrying once with the validation error), records
 * token usage and saves the transcript to `.data/cases/<caseId>/<phase>-<n>.jsonl`.
 */
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isReadTool, qualified } from '../mcp/tools';
import { errorMessage } from '../util';
import { addUsage, emptyUsage, type LlmProvider, type PhaseUsage } from './provider';

export interface PhaseSpec<T> {
  name: string;
  caseId?: string;
  system: string;
  prompt: string;
  /** Read-only MCP tools the phase may use, e.g. ['search_logs', 'get_app']. */
  tools: string[];
  schema: z.ZodType<T>;
  /** Defaults to the runner's fast model. */
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export type PhaseOutcome<T> =
  | { ok: true; value: T; usage: PhaseUsage; attempts: number; transcripts: string[] }
  | { ok: false; error: string; usage: PhaseUsage; attempts: number; transcripts: string[] };

export class PhaseToolError extends Error {
  override name = 'PhaseToolError';
}

/** Rejects any tool that isn't a known read tool. */
export function assertReadOnly(phase: string, tools: string[]): void {
  const writes = tools.filter((t) => !isReadTool(t));
  if (writes.length) {
    throw new PhaseToolError(
      `Phase "${phase}" asked for non-read tools (${writes.join(', ')}). Phases are read-only; ` +
        'the orchestrator performs every write.',
    );
  }
}

/** The guard handed to the provider: only the phase's own read tools, by qualified name. */
export function toolGuard(tools: string[]): (qualifiedTool: string) => boolean {
  const allowed = new Set(tools.filter(isReadTool).map(qualified));
  return (name) => allowed.has(name);
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Pulls a JSON value out of free text (a ```json fence, or the outermost {...}). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

export interface RunnerOptions {
  provider: LlmProvider;
  dataDir: string;
  model: string;
  deepModel: string;
}

export class PhaseRunner {
  constructor(private readonly opts: RunnerOptions) {}

  get models() {
    return { fast: this.opts.model, deep: this.opts.deepModel };
  }

  private transcriptPath(caseId: string | undefined, phase: string): string {
    const dir = path.join(this.opts.dataDir, 'cases', caseId ?? '_global');
    mkdirSync(dir, { recursive: true });
    const n = readdirSync(dir).filter((f) => f.startsWith(`${phase}-`)).length + 1;
    return path.join(dir, `${phase}-${n}.jsonl`);
  }

  async run<T>(spec: PhaseSpec<T>): Promise<PhaseOutcome<T>> {
    assertReadOnly(spec.name, spec.tools);
    const jsonSchema = toJsonSchema(spec.schema);
    const guard = toolGuard(spec.tools);
    const timeoutMs = spec.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let usage = emptyUsage();
    const transcripts: string[] = [];
    let prompt = spec.prompt;
    let lastError = 'no answer';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        lastError = `timed out after ${Math.round(timeoutMs / 1000)}s`;
        break;
      }
      const file = this.transcriptPath(spec.caseId, spec.name);
      transcripts.push(file);
      const write = (entry: unknown) => {
        try {
          appendFileSync(file, `${JSON.stringify(entry)}\n`);
        } catch {
          // transcripts are best-effort
        }
      };
      write({
        type: 'phase_start',
        phase: spec.name,
        attempt,
        model: spec.model ?? this.opts.model,
        tools: spec.tools,
        prompt,
      });

      const signal = AbortSignal.timeout(remaining);
      let response: Awaited<ReturnType<LlmProvider['run']>>;
      try {
        response = await this.opts.provider.run({
          phase: spec.name,
          system: spec.system,
          prompt,
          model: spec.model ?? this.opts.model,
          tools: spec.tools,
          jsonSchema,
          maxTurns: spec.maxTurns ?? 20,
          signal,
          guard,
          onMessage: write,
        });
      } catch (err) {
        response = { text: '', usage: emptyUsage(), error: errorMessage(err) };
      }
      usage = addUsage(usage, response.usage);

      if (response.error && response.output === undefined && !response.text) {
        lastError = response.error;
        write({ type: 'phase_error', error: lastError });
        // Provider failures (timeouts, budget) aren't fixed by asking again.
        break;
      }
      const candidate = response.output ?? extractJson(response.text);
      const parsed = spec.schema.safeParse(candidate);
      if (parsed.success) {
        write({ type: 'phase_result', ok: true, usage });
        return { ok: true, value: parsed.data, usage, attempts: attempt, transcripts };
      }
      lastError =
        candidate === undefined
          ? 'the answer contained no JSON'
          : `the answer did not match the schema:\n${formatIssues(parsed.error)}`;
      write({ type: 'phase_invalid', error: lastError });
      prompt =
        `${spec.prompt}\n\nYour previous answer was rejected because ${lastError}\n` +
        'Answer again with JSON that matches the schema exactly.';
    }
    return { ok: false, error: lastError, usage, attempts: transcripts.length, transcripts };
  }
}
