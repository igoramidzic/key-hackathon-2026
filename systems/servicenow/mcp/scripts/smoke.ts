/**
 * Calls every ServiceNow MCP tool through a real MCP client over Streamable HTTP and walks an
 * incident through create → update → resolve, then a second one through its change request,
 * communication draft, resolution section and problem. Needs the API (4002) and MCP server (5002)
 * running. It leaves its records behind: `curl -X POST localhost:4002/admin/reset` clears them.
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

// ----- Affected CIs, child incidents, change request -----
const outage = await call<{ number: string; affected_cis: string[]; outage_start: string }>(
  'create_incident',
  {
    short_description: 'CIF - customer profile lookups failing',
    app_tla: 'CIF',
    impact: 1,
    urgency: 1,
    affected_cis: ['OLB', 'mbl', 'CIF'],
    outage_start: '20m',
  },
);
check(
  outage.affected_cis.join() === 'OLB,MBL',
  `affected_cis are upper case without the incident's own app (got ${outage.affected_cis})`,
);
check(outage.outage_start, 'outage_start set on create');

const phoned = await call<{ number: string }>('create_incident', {
  short_description: 'Cannot open a customer profile',
  contact_type: 'phone',
  caller: 'mlopez',
  opened_by: 'pnatarajan',
});
const grouped = await call<{ child_incidents: unknown[] }>('link_child_incidents', {
  parent: outage.number,
  children: [phoned.number],
  child_comment: `This is a known outage tracked in ${outage.number}.`,
});
check(grouped.child_incidents.length === 1, 'call linked as a child incident');

// No planned_start: the change stays a draft, so KBR leaves it alone.
const change = await call<{ number: string; state: string }>('create_change_request', {
  short_description: 'CIF - revert naming strategy change',
  app_tla: 'CIF',
  merge_requests: ['keybank/CIF00/customer-profile-api!7'],
  type: 'emergency',
  related_incidents: [outage.number],
});
check(change.state === 'new', 'change request without planned_start is a draft');
await call('get_change_request', { number: change.number });
const changes = await call<{ items: { number: string }[] }>('list_change_requests', {
  app_tla: 'CIF',
  related_incident: outage.number,
});
check(
  changes.items.some((c) => c.number === change.number),
  'change request listed for the incident',
);

// ----- Critical Incident Communications: drafted here, sent by a person in the UI -----
type Draft = { number: string; state: string; subject: string; to: string; web_url: string };
const draft = await call<Draft>('draft_incident_communication', {
  incident: outage.number,
  kind: 'new',
  description: 'Customers cannot open their profile in online and mobile banking.',
});
check(draft.state === 'draft', 'communication is a draft');
check(draft.to === 'GRP_CIM_Tech_P1', `P1 goes to GRP_CIM_Tech_P1 (got ${draft.to})`);
check(
  draft.subject === `<page> NEW - ${outage.number} - CIF - customer profile lookups failing`,
  `subject is tagged NEW (got ${draft.subject})`,
);
check(draft.web_url.endsWith(draft.number), 'communication web_url ends with the number');
const redraft = await call<Draft>('draft_incident_communication', {
  incident: outage.number,
  kind: 'new',
  description: 'Customers and bankers cannot open customer profiles.',
  client_impact: 'Customers cannot view or update their profile.',
});
check(redraft.number === draft.number, 're-drafting the same kind updates the draft in place');
const email = await call<{ description: string; systems_impacted: string[] }>(
  'get_incident_communication',
  { number: draft.number },
);
check(email.description.startsWith('Customers and bankers'), 'draft holds the new wording');
check(email.systems_impacted.join() === 'CIF,OLB,MBL', 'systems impacted = app + affected CIs');
const drafts = await call<{ total: number }>('list_incident_communications', {
  incident: outage.number,
  state: 'draft',
});
check(drafts.total === 1, `one draft for the incident (got ${drafts.total})`);
check(
  !tools.some((t) => /send.*communication|communication.*send/.test(t.name)),
  'no tool sends a communication',
);

// ----- Resolution section -----
await call('update_incident', { number: outage.number, caused_by_change: 'CHG0999999' }, true);
const restored = await call<{
  state: string;
  outage_duration_minutes: number;
  cause_code: string;
  resolved_by_change: string;
}>('update_incident', {
  number: outage.number,
  state: 'resolved',
  close_code: 'Resolved by change',
  close_notes: 'Naming strategy change reverted.',
  service_restored_at: 'now',
  cause_code: 'Change',
  resolved_by_change: change.number,
  root_cause: 'A naming strategy change renamed the columns the profile queries rely on.',
  client_impact: 'Customers could not view their profile for about 20 minutes.',
  employee_impact: 'Bankers could not look up customer profiles.',
});
check(restored.state === 'resolved', 'outage resolved');
check(
  Math.abs(restored.outage_duration_minutes - 20) <= 1,
  `outage duration derived (got ${restored.outage_duration_minutes} minutes)`,
);
check(restored.resolved_by_change === change.number, 'resolved_by_change recorded');
await call('update_change_request', {
  number: change.number,
  state: 'canceled',
  work_note: 'Smoke test only.',
});

// ----- Problems (the 8:00 AM stand-up) -----
type Prb = { number: string; priority: number; standup_date: string | null; web_url: string };
const problem = await call<Prb & { cause_code: string; incidents: string[] }>('create_problem', {
  short_description: 'CIF - naming strategy change broke customer profile lookups',
  incidents: [outage.number],
  root_cause: 'A naming strategy change renamed the columns the profile queries rely on.',
  mitigation_plan: 'Reverted through an emergency change request.',
  action_items: '- Add a schema contract test to the CIF pipeline (CIF team)',
});
check(
  /^PRB\d{7}$/.test(problem.number),
  `problem number looks like PRB0040001 (${problem.number})`,
);
check(problem.priority === 1, 'problem takes the priority of its incident');
check(problem.cause_code === 'Under investigation', 'cause_code defaults to Under investigation');
check(/^\d{4}-\d{2}-\d{2}$/.test(problem.standup_date ?? ''), 'problem is on the next stand-up');
check(problem.web_url.endsWith(problem.number), 'problem web_url ends with the number');
await call('create_problem', { short_description: 'Again', incidents: [outage.number] }, true);
const mine = await call<{ items: { number: string }[] }>('list_problems', {
  incident: outage.number,
});
check(mine.items.length === 1 && mine.items[0]?.number === problem.number, 'found by incident');
const agenda = await call<{ items: { number: string }[] }>('list_problems', {
  standup: 'next',
  active: true,
});
check(
  agenda.items.some((p) => p.number === problem.number),
  'problem is on the next stand-up agenda',
);
const worked = await call<{ state: string; journal: { type: string }[] }>('update_problem', {
  number: problem.number,
  state: 'root_cause_analysis',
  cause_code: 'Change',
  work_note: 'Timeline attached.',
});
check(worked.state === 'root_cause_analysis', 'problem moved to root_cause_analysis');
const prb = await call<{ related_incidents: { number: string }[] }>('get_problem', {
  number: problem.number,
});
check(prb.related_incidents[0]?.number === outage.number, 'problem lists its incident');
const final = await call<{ problem: string; communications: { number: string }[] }>(
  'get_incident',
  { number: outage.number },
);
check(final.problem === problem.number, 'incident points at its problem');
check(final.communications[0]?.number === draft.number, 'incident lists its communications');

const missing = tools.map((t) => t.name).filter((n) => !called.has(n));
check(missing.length === 0, `tools not exercised: ${missing.join(', ')}`);

await client.close();
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `\nAll ${called.size} tools OK. Created and resolved ${created.number} and ${outage.number}, opened ${problem.number}, drafted ${draft.number}.`,
);
