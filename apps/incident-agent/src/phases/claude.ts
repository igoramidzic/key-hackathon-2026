/**
 * Claude provider: one phase = one `query()` from the Claude Agent SDK with the four MCP servers
 * attached, no built-in tools, read tools pre-approved, write tools removed, and everything else
 * denied (`permissionMode: 'dontAsk'` plus a `canUseTool` guard).
 */
import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerName } from '../config';
import { ALL_WRITE_TOOLS, qualified } from '../mcp/tools';
import { errorMessage } from '../util';
import type { LlmProvider, PhaseUsage, ProviderRequest, ProviderResponse } from './provider';

export function buildClaudeOptions(
  req: ProviderRequest,
  mcpUrls: Record<ServerName, string>,
  abortController: AbortController,
): Options {
  return {
    model: req.model,
    systemPrompt: req.system,
    mcpServers: {
      logs: { type: 'http', url: mcpUrls.logs },
      servicenow: { type: 'http', url: mcpUrls.servicenow },
      gitlab: { type: 'http', url: mcpUrls.gitlab },
      teams: { type: 'http', url: mcpUrls.teams },
    },
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    allowedTools: req.tools.map(qualified),
    disallowedTools: ALL_WRITE_TOOLS.map(qualified),
    permissionMode: 'dontAsk',
    canUseTool: async (toolName, input) =>
      req.guard(toolName)
        ? { behavior: 'allow', updatedInput: input }
        : {
            behavior: 'deny',
            message: `${toolName} is not available in the ${req.phase} phase (read-only investigator).`,
          },
    maxTurns: req.maxTurns,
    abortController,
    outputFormat: { type: 'json_schema', schema: req.jsonSchema },
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'sim-incident-agent/0.1.0' },
  };
}

// The SDK warns that pre-approved read tools skip canUseTool. That is intended (canUseTool only
// guards everything else), so the warning is noise in the agent's log.
let warningFilterInstalled = false;
function muteShadowWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const code =
      typeof rest[0] === 'object' && rest[0] ? (rest[0] as { code?: string }).code : rest[1];
    if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
    (original as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Is a model reachable with the credentials this process has? One tiny request, no tools. */
export async function pingClaude(
  model: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; detail: string }> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    for await (const message of query({
      prompt: 'Reply with the single word OK.',
      options: {
        model,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        maxTurns: 1,
        permissionMode: 'dontAsk',
        abortController,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'sim-incident-agent/0.1.0' },
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error)
        return { ok: true, detail: `${model} answered` };
      const text = message.subtype === 'success' ? message.result : message.subtype;
      return { ok: false, detail: text };
    }
    return { ok: false, detail: 'no answer' };
  } catch (err) {
    return { ok: false, detail: abortController.signal.aborted ? 'timed out' : errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  constructor(private readonly mcpUrls: Record<ServerName, string>) {
    muteShadowWarning();
  }

  async run(req: ProviderRequest): Promise<ProviderResponse> {
    const started = Date.now();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    const usage: PhaseUsage = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
      durationMs: 0,
    };
    let text = '';
    let output: unknown;
    let error: string | undefined;
    try {
      const options = buildClaudeOptions(req, this.mcpUrls, abortController);
      for await (const message of query({
        prompt: req.prompt,
        options,
      }) as AsyncIterable<SDKMessage>) {
        req.onMessage(message);
        if (message.type !== 'result') continue;
        usage.turns = message.num_turns;
        usage.costUsd = message.total_cost_usd;
        for (const m of Object.values(message.modelUsage ?? {})) {
          usage.inputTokens += m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
          usage.outputTokens += m.outputTokens;
        }
        if (message.subtype === 'success' && message.is_error) {
          // e.g. "Failed to authenticate: …": a provider failure, not an answer to validate.
          error = message.result;
        } else if (message.subtype === 'success') {
          text = message.result;
          output = message.structured_output;
        } else {
          error = `${message.subtype}${message.stop_reason ? ` (${message.stop_reason})` : ''}`;
        }
      }
    } catch (err) {
      error = req.signal.aborted ? 'timed out' : errorMessage(err);
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
    usage.durationMs = Date.now() - started;
    return { output, text, usage, error };
  }
}
