/**
 * Calls every ServiceNow MCP tool through a real MCP client over Streamable HTTP and walks an
 * incident through create → update → resolve. Needs the API (4002) and MCP server (5002) running.
 *
 *   pnpm --filter @sim/servicenow-mcp exec tsx scripts/smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URLS } from '@sim/contracts';

const url = process.env.SERVICENOW_MCP_URL ?? URLS.servicenow.mcp;
const client = new Client({ name: 'servicenow-smoke', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const failures: string[] = [];
const called = new Set<string>();

async function call<T = unknown>(name: string, args: Record<string, unknown>, expectError = false) {
  called.add(name);
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content[0]?.text ?? '';
  const isError = result.isError === true;
  if (isError !== expectError)
    failures.push(`${name}: expected ${expectError ? 'an error' : 'success'}, got: ${text}`);
  console.log(
    `${isError ? '✗' : '✓'} ${name} ${JSON.stringify(args)} → ${text.length} chars${isError ? `: ${text}` : ''}`,
  );
  return (isError ? text : JSON.parse(text)) as T;
}

function check(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

const info = client.getServerVersion();
console.log(`Connected to ${info?.name} ${info?.version}`);
check(client.getInstructions()?.includes('TLA'), 'server instructions mention TLA');

const { tools } = await client.listTools();
console.log(`Tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

// ----- Reads -----
const open = await call<{ total: number; items: { number: string; priority: number }[] }>(
  'list_incidents',
  { active: true, sort: 'priority', limit: 5 },
);
check(open.total >= 12, `expected >= 12 open incidents, got ${open.total}`);
check(
  open.items.every((i) => i.priority >= 3),
  'seeded open incidents are P3-P5',
);
await call('list_incidents', { state: ['closed'], app_tla: 'CIF', limit: 3 });
await call('list_incidents', { query: 'timing out', opened_after: '90d', limit: 3 });
const first = await call<{ number: string; journal: unknown[] }>('get_incident', {
  number: 'INC0010001',
});
check(first.journal.length > 0, 'INC0010001 has journal entries');
await call('get_incident', { number: 'INC0999999' }, true);

const apps = await call<{ items: { tla: string }[] }>('search_apps', {
  query: 'payments',
  limit: 5,
});
check(
  apps.items[0]?.tla === 'PAY',
  `search_apps "payments" ranks PAY first (got ${apps.items[0]?.tla})`,
);
await call('search_apps', { tier: 1, business_unit: 'Payments' });
const pay = await call<{
  support_group: { id: string; on_call: { primary: { username: string; phone: string } } };
  upstream: { tla: string }[];
}>('get_app', { tla: 'pay' });
check(pay.support_group.on_call.primary.phone, 'get_app returns on-call phone');
const ath = await call<{ downstream_count: number; downstream: unknown[] }>('get_app', {
  tla: 'ATH',
});
check(
  ath.downstream.length <= 25 && ath.downstream_count > 25,
  'get_app truncates long downstream lists',
);
await call('get_app', { tla: 'ZZZ' }, true);
const deps = await call<{ nodes: { tla: string }[]; edges: string[] }>('get_app_dependencies', {
  tla: 'ACH',
  direction: 'up',
  depth: 2,
});
check(
  deps.nodes.some((n) => n.tla === 'ATH'),
  'ACH depends on ATH',
);

const groups = await call<{ items: { id: string }[] }>('search_support_groups', {
  type: 'infrastructure',
});
check(groups.items.length === 5, 'five infrastructure groups');
await call('search_support_groups', { query: 'PAY' });
await call('get_support_group', { group: pay.support_group.id });
await call('get_support_group', { group: 'Enterprise Command Center (NOC)' });
await call('search_users', { query: 'whitfield' });
await call('search_users', { group: 'grp_noc', limit: 3 });
const dana = await call<{ groups: { id: string }[] }>('get_user', { username: 'dwhitfield' });
check(
  dana.groups.some((g) => g.id === 'grp_noc'),
  'dwhitfield is in the NOC',
);
await call('get_user', { username: 'nobody' }, true);

// ----- Lifecycle: create → update → note → resolve -----
const created = await call<{ number: string; priority: number; state: string; web_url: string }>(
  'create_incident',
  {
    short_description: 'PAY - payment submissions failing with HTTP 500',
    description: 'Moogsoft alert: 5xx rate 23% on payments-api.',
    app_tla: 'PAY',
    impact: 1,
    urgency: 1,
    assignment_group: pay.support_group.id,
  },
);
check(created.priority === 1 && created.state === 'new', 'new incident is P1 / new');
check(created.web_url.endsWith(created.number), 'web_url ends with the number');

const updated = await call<{
  state: string;
  assigned_to: { username: string };
  links: unknown[];
  journal: { type: string }[];
}>('update_incident', {
  number: created.number,
  state: 'in_progress',
  assigned_to: pay.support_group.on_call.primary.username,
  work_note: 'Engaged PAY on-call. Suspect upstream ACH.',
  add_links: [
    {
      type: 'teams_channel',
      url: 'http://localhost:3004/channels/inc-pay',
      title: '#inc-pay-500s',
    },
    {
      type: 'log_query',
      url: 'http://localhost:3001/logs?query=labels.app_tla%3D%22PAY%22',
      title: 'PAY logs',
    },
  ],
});
check(updated.state === 'in_progress', 'state moved to in_progress');
check(updated.links.length === 2, 'two links attached');
check(
  updated.journal.some((j) => j.type === 'system'),
  'system journal entry recorded',
);

await call('add_incident_note', {
  number: created.number,
  text: 'Bridge open, 6 engineers joined.',
});
await call('add_incident_note', {
  number: created.number,
  type: 'comment',
  text: 'We are aware of payment failures and are working on it.',
  author: 'dwhitfield',
});
await call('update_incident', { number: created.number, state: 'resolved' }, true);
const resolved = await call<{ state: string; close_code: string; resolved_at: string }>(
  'update_incident',
  {
    number: created.number,
    state: 'resolved',
    close_code: 'Resolved by change',
    close_notes: 'Reverted MR !42 in keybank/PAY00/payments-api.',
    add_links: [
      {
        type: 'merge_request',
        url: 'http://localhost:3003/keybank/PAY00/payments-api/-/merge_requests/42',
        title: 'PAY00/payments-api!42',
      },
    ],
  },
);
check(resolved.state === 'resolved' && resolved.resolved_at, 'incident resolved');

const after = await call<{ items: { number: string }[] }>('list_incidents', {
  app_tla: 'PAY',
  state: ['resolved'],
});
check(
  after.items.some((i) => i.number === created.number),
  'resolved incident appears in list_incidents',
);

const missing = tools.map((t) => t.name).filter((n) => !called.has(n));
check(missing.length === 0, `tools not exercised: ${missing.join(', ')}`);

await client.close();
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nAll ${called.size} tools OK. Created and resolved ${created.number}.`);
