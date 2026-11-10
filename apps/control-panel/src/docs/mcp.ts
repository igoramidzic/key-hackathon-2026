import { PORTS, SYSTEMS, type SystemName, URLS } from '@sim/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';

/**
 * A minimal MCP client over Streamable HTTP. The servers are stateless and answer JSON, so one
 * POST per JSON-RPC call is enough (no session, no initialize handshake needed for tools/*).
 */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}

export interface ServerInfo {
  system: SystemName;
  title: string;
  version: string;
  instructions: string;
  tools: McpTool[];
}

export interface CallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

/** The order the servers appear in the docs, and their short labels. */
export const SERVERS: { system: SystemName; label: string; blurb: string }[] = [
  {
    system: 'logs',
    label: 'Logs',
    blurb: 'Cloud Logging search, error summaries, live tail and Moogsoft alerts.',
  },
  {
    system: 'servicenow',
    label: 'ServiceNow',
    blurb: 'Incidents, the app catalog with dependencies, support groups and people.',
  },
  {
    system: 'gitlab',
    label: 'GitLab',
    blurb: 'Projects, commits, merge requests with diffs, files, and opening fix MRs.',
  },
  {
    system: 'teams',
    label: 'Teams',
    blurb: 'Incident channels with members and reasons, messages and notifications.',
  },
];

export const serverLabel = (system: SystemName) =>
  SERVERS.find((s) => s.system === system)?.label ?? system;

export const isSystem = (v: string | undefined): v is SystemName =>
  SYSTEMS.includes(v as SystemName);

/** MCP endpoint of the host this page is served from (what "Try it" calls). */
export const liveMcpUrl = (system: SystemName) => URLS[system].mcp;

let rpcId = 0;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export async function rpc<T>(url: string, method: string, params?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result as T;
}

async function loadServer(system: SystemName): Promise<ServerInfo> {
  const url = liveMcpUrl(system);
  const [init, list] = await Promise.all([
    rpc<{ serverInfo: { title?: string; name: string; version: string }; instructions?: string }>(
      url,
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'sim-docs', version: '1' },
      },
    ),
    rpc<{ tools: McpTool[] }>(url, 'tools/list'),
  ]);
  return {
    system,
    title: init.serverInfo.title ?? init.serverInfo.name,
    version: init.serverInfo.version,
    instructions: init.instructions ?? '',
    tools: list.tools,
  };
}

const serverQuery = (system: SystemName) => ({
  queryKey: ['mcp', system],
  queryFn: () => loadServer(system),
  staleTime: 60_000,
  retry: 1,
});

/** Live server info and tool list, straight from the running MCP server. */
export function useServer(system: SystemName) {
  return useQuery(serverQuery(system));
}

export function useAllServers() {
  const queries = useQueries({ queries: SERVERS.map((s) => serverQuery(s.system)) });
  return SERVERS.map((s, i) => ({ ...s, query: queries[i]! }));
}

export async function callTool(system: SystemName, name: string, args: unknown) {
  return rpc<CallResult>(liveMcpUrl(system), 'tools/call', { name, arguments: args });
}

// ---------------------------------------------------------------------------
// Endpoints for snippets: local dev ports or the hosted single-origin Worker.
// ---------------------------------------------------------------------------

export const HOSTED_ORIGIN = 'https://hackathon-incident-lab.kualia.workers.dev';

export type Target = 'local' | 'hosted';

/** Hosted origin for snippets: this page's origin when it is itself the hosted copy. */
export function hostedOrigin(): string {
  return URLS.logs.mcp.startsWith('http://localhost:') ? HOSTED_ORIGIN : window.location.origin;
}

export function defaultTarget(): Target {
  return URLS.logs.mcp.startsWith('http://localhost:') ? 'local' : 'hosted';
}

export function endpoints(target: Target) {
  const h = hostedOrigin();
  const local = target === 'local';
  return {
    mcp: (s: SystemName) => (local ? `http://localhost:${PORTS[s].mcp}/mcp` : `${h}/${s}/mcp`),
    logsApi: local ? `http://localhost:${PORTS.logs.api}` : `${h}/logs`,
    simApi: local ? `http://localhost:${PORTS.simulator.api}` : h,
    controlPanel: local ? `http://localhost:${PORTS.simulator.web}` : h,
  };
}

// ---------------------------------------------------------------------------
// JSON Schema helpers for the parameter tables and the "Try it" example.
// ---------------------------------------------------------------------------

export interface Param {
  name: string;
  path: string;
  depth: number;
  type: string;
  required: boolean;
  schema: JsonSchema;
  enumValues?: unknown[];
  constraints: string[];
}

export function typeLabel(s: JsonSchema): string {
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return [...new Set(alts.map(typeLabel))].join(' | ');
  if (s.enum) return s.type ? String(s.type) : 'enum';
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.type === 'array') {
    const inner = s.items ? typeLabel(s.items) : 'any';
    return inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
  }
  return s.type ?? 'any';
}

function constraintsOf(s: JsonSchema): string[] {
  const c: string[] = [];
  if (s.minimum !== undefined && s.maximum !== undefined) c.push(`${s.minimum}–${s.maximum}`);
  else if (s.minimum !== undefined) c.push(`≥ ${s.minimum}`);
  else if (s.maximum !== undefined) c.push(`≤ ${s.maximum}`);
  if (s.minItems !== undefined && s.minItems > 0) c.push(`min ${s.minItems} items`);
  if (s.maxItems !== undefined) c.push(`max ${s.maxItems} items`);
  if (s.maxLength !== undefined) c.push(`max length ${s.maxLength}`);
  if (s.format) c.push(s.format);
  if (s.pattern) c.push(`/${s.pattern}/`);
  return c;
}

const objectOf = (s: JsonSchema): JsonSchema | undefined => {
  if (s.type === 'object' && s.properties) return s;
  if (s.type === 'array' && s.items?.type === 'object' && s.items.properties) return s.items;
  return undefined;
};

/** Flattens an input schema into table rows, nested objects and object arrays indented. */
export function flattenParams(schema: JsonSchema, prefix = '', depth = 0): Param[] {
  const required = new Set(schema.required ?? []);
  const rows: Param[] = [];
  for (const [name, s] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    rows.push({
      name,
      path,
      depth,
      type: typeLabel(s),
      required: required.has(name),
      schema: s,
      enumValues: s.enum ?? s.items?.enum,
      constraints: constraintsOf(s),
    });
    const nested = objectOf(s);
    if (nested)
      rows.push(...flattenParams(nested, s.type === 'array' ? `${path}[]` : path, depth + 1));
  }
  return rows;
}

/** Pulls `e.g. "x"`, `Example: [..]` style examples out of a field description. */
function exampleFromDescription(s: JsonSchema): unknown {
  const m = s.description?.match(
    /(?:e\.g\.|Example:)\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\]|-?\d+(?:\.\d+)?)/,
  );
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[1]!);
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    if (t === 'array' && !Array.isArray(v)) return [v];
    if (t === 'number' || t === 'integer') return typeof v === 'number' ? v : undefined;
    if (t === 'string' && typeof v !== 'string') return undefined;
    return v;
  } catch {
    return undefined;
  }
}

function exampleValue(s: JsonSchema): unknown {
  const fromDesc = exampleFromDescription(s);
  if (fromDesc !== undefined) return fromDesc;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  const alt = (s.anyOf ?? s.oneOf)?.[0];
  if (alt) return exampleValue(alt);
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return s.minimum ?? 1;
    case 'boolean':
      return false;
    case 'array':
      return s.items ? [exampleValue(s.items)] : [];
    case 'object':
      return exampleArgs(s);
    default:
      return null;
  }
}

/** Arguments to pre-fill "Try it" with: required fields only, filled from examples/defaults. */
export function exampleArgs(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const s = schema.properties?.[key];
    if (s) out[key] = exampleValue(s);
  }
  return out;
}

export type ToolKind = 'read' | 'write' | 'idempotent';

export function toolKind(t: McpTool): ToolKind {
  if (t.annotations?.readOnlyHint) return 'read';
  return t.annotations?.idempotentHint ? 'idempotent' : 'write';
}

/** Parses a tool result's text content as JSON when it is JSON. */
export function resultValue(r: CallResult): { json?: unknown; text: string } {
  const text = (r.content ?? [])
    .map((c) => c.text ?? '')
    .filter(Boolean)
    .join('\n');
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { text };
  }
}
