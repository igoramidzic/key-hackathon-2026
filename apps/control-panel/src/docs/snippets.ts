import type { SystemName } from '@sim/contracts';
import { endpoints, SERVERS, type Target } from './mcp';

const SYS = SERVERS.map((s) => s.system);

export function connectSnippets(target: Target) {
  const ep = endpoints(target);
  const url = (s: SystemName) => ep.mcp(s);

  const claudeCli = SYS.map((s) => `claude mcp add --transport http sim-${s} ${url(s)}`).join('\n');

  const mcpJson = JSON.stringify(
    { mcpServers: Object.fromEntries(SYS.map((s) => [`sim-${s}`, { type: 'http', url: url(s) }])) },
    null,
    2,
  );

  const agentSdk = `import { query } from '@anthropic-ai/claude-agent-sdk';

const mcpServers = {
${SYS.map((s) => `  ${s}: { type: 'http' as const, url: '${url(s)}' },`).join('\n')}
};

for await (const msg of query({
  prompt: 'Moogsoft alerts are firing. Investigate and run the incident process.',
  options: {
    mcpServers,
    // Allow every tool on the four servers (tool names are mcp__<server>__<tool>).
    allowedTools: [${SYS.map((s) => `'mcp__${s}'`).join(', ')}],
  },
})) {
  if (msg.type === 'result') console.log(msg);
}`;

  const adk = `from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import MCPToolset, StreamableHTTPConnectionParams

URLS = [
${SYS.map((s) => `    "${url(s)}",`).join('\n')}
]

agent = LlmAgent(
    name="incident_agent",
    model="...",
    instruction="Investigate alerts and run the incident process.",
    tools=[MCPToolset(connection_params=StreamableHTTPConnectionParams(url=u)) for u in URLS],
)`;

  const rawSdk = `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const gitlab = new Client({ name: 'my-agent', version: '0.1.0' });
await gitlab.connect(new StreamableHTTPClientTransport(new URL('${url('gitlab')}')));

const { tools } = await gitlab.listTools();
const res = await gitlab.callTool({
  name: 'list_merge_requests',
  arguments: { tla: 'CIF', state: 'merged', merged_after: '6h' },
});
console.log(JSON.parse(res.content[0].text));`;

  const curl = `# List the tools (no handshake needed: the servers are stateless)
curl -s ${url('servicenow')} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call one
curl -s ${url('servicenow')} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_app","arguments":{"tla":"CIF"}}}'`;

  const inspector = `npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: ${url('gitlab')}`;

  return { claudeCli, mcpJson, agentSdk, adk, rawSdk, curl, inspector };
}

export function curlForCall(url: string, name: string, args: unknown): string {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }).replace(/'/g, `'\\''`);
  return `curl -s ${url} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '${body}'`;
}

export function tsForCall(system: SystemName, url: string, name: string, args: unknown): string {
  return `// ${system} client connected as in "Connect" (StreamableHTTPClientTransport → ${url})
const res = await ${system}.callTool({
  name: '${name}',
  arguments: ${JSON.stringify(args, null, 2).replace(/\n/g, '\n  ')},
});
const data = JSON.parse(res.content[0].text); // isError: true carries a readable message instead`;
}

export function pythonForCall(url: string, name: string, args: unknown): string {
  return `import json, requests

args = json.loads(r'''${JSON.stringify(args)}''')
res = requests.post(
    "${url}",
    headers={"content-type": "application/json", "accept": "application/json, text/event-stream"},
    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
          "params": {"name": "${name}", "arguments": args}},
).json()["result"]
data = json.loads(res["content"][0]["text"])`;
}
