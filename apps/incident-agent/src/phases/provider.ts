/**
 * The LLM provider behind a small interface. Only Claude (Agent SDK) is implemented; a Gemini
 * adapter would implement the same `run`.
 */

export interface PhaseUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
}

export const emptyUsage = (): PhaseUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  turns: 0,
  durationMs: 0,
});

export function addUsage(a: PhaseUsage, b: PhaseUsage): PhaseUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
  };
}

export interface ProviderRequest {
  phase: string;
  system: string;
  prompt: string;
  model: string;
  /** Plain MCP tool names (read-only), e.g. `search_logs`. */
  tools: string[];
  /** JSON Schema the answer must match. */
  jsonSchema: Record<string, unknown>;
  maxTurns: number;
  signal: AbortSignal;
  /** Last line of defence: true when the model may call this (qualified) tool. */
  guard: (qualifiedTool: string) => boolean;
  /** Every raw provider message, for the transcript. */
  onMessage: (message: unknown) => void;
}

export interface ProviderResponse {
  /** Structured output when the provider supports it. */
  output?: unknown;
  /** Final text (JSON is extracted from it when there is no structured output). */
  text: string;
  usage: PhaseUsage;
  error?: string;
}

export interface LlmProvider {
  readonly name: string;
  run(request: ProviderRequest): Promise<ProviderResponse>;
}
