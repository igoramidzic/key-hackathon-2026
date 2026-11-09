/**
 * Exercises every tool of the logs MCP server through a real MCP client (Streamable HTTP).
 *
 *   pnpm --filter @sim/logs-mcp smoke            # against http://localhost:5001/mcp
 *   LOGS_MCP_URL=http://host:5001/mcp pnpm --filter @sim/logs-mcp smoke
 *
 * Needs the logs API with some data (e.g. `pnpm --filter @sim/logs-api seed`).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URLS } from '@sim/contracts';

const url = new URL(process.env.LOGS_MCP_URL ?? URLS.logs.mcp);
const client = new Client({ name: 'logs-smoke', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));

let failures = 0;

async function call(name: string, args: Record<string, unknown>, expectError = false) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
  const ok = Boolean(res.isError) === expectError;
  if (!ok) failures++;
  console.log(`\n${ok ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(args)}`);
  console.log(`     ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
  // biome-ignore lint/suspicious/noExplicitAny: smoke test output
  return expectError ? undefined : (JSON.parse(text) as any);
}

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
console.log(`instructions: ${client.getInstructions()?.slice(0, 120)}…`);

const summary = await call('summarize_errors', { limit: 3 });
const top = summary.items[0];
await call('list_log_services', { limit: 3 });
await call('get_log_histogram', { severity_min: 'ERROR', start_time: '15m' });
const search = await call('search_logs', {
  filter: `severity>=ERROR resource.labels.container_name="${top?.service ?? 'payments-api'}"`,
  limit: 2,
});
if (search.next_cursor) {
  await call('search_logs', {
    filter: `severity>=ERROR resource.labels.container_name="${top?.service ?? 'payments-api'}"`,
    limit: 2,
    cursor: search.next_cursor,
  });
}
await call('search_logs', { app_tla: 'PAY,DEP', text: 'timed out', order: 'asc', limit: 1 });
await call('search_logs', { filter: 'severity>=' }, true); // parse error is a tool error
if (search.items[0]) await call('get_log_entry', { insert_id: search.items[0].insert_id });
await call('get_log_entry', { insert_id: 'does-not-exist' }, true);

const tail = await call('tail_logs', { severity_min: 'ERROR', limit: 2 });
const started = Date.now();
await call('tail_logs', { after_seq: tail.cursor, wait_seconds: 2 });
console.log(`     (long-poll returned after ${Date.now() - started}ms)`);

const alerts = await call('list_alerts', { limit: 3 });
await call('list_alerts', { status: ['resolved', 'closed'], limit: 2 });
const id = alerts.items[0]?.id;
if (id) {
  await call('get_alert', { id });
  await call('update_alert', {
    id,
    status: 'acknowledged',
    owner: 'svc_incident_auto',
    incident_number: 'INC0012345',
    note: 'Investigating via logs MCP smoke test.',
  });
}
await call('update_alert', { id: id ?? 48201 }, true); // nothing to update
await call('get_alert', { id: 1 }, true);

await client.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tool calls behaved as expected');
process.exit(failures ? 1 : 0);
