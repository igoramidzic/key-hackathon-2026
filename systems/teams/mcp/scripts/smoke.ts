/**
 * End-to-end check of every Teams MCP tool through a real MCP client.
 * Needs teams-api (4004) and teams-mcp (5004) running. Resets the Teams API first.
 *   pnpm --filter @sim/teams-mcp exec tsx scripts/smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = process.env.TEAMS_MCP_URL ?? 'http://localhost:5004/mcp';
const API = process.env.TEAMS_API_URL ?? 'http://localhost:4004';

// biome-ignore lint/suspicious/noExplicitAny: smoke test inspects loosely-typed tool JSON
type Json = any;

const client = new Client({ name: 'teams-smoke', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log('      ', JSON.stringify(detail).slice(0, 800));
  }
}

async function raw(name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
}

async function call(name: string, args: Record<string, unknown>): Promise<Json> {
  const res = await raw(name, args);
  const text = res.content[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await raw(name, args);
  return res.isError ? (res.content[0]?.text ?? '') : '';
}

await fetch(`${API}/admin/reset`, { method: 'POST' });

const instructions = client.getInstructions();
check('server instructions present', !!instructions?.includes('inc<number>-<short-slug>'));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  'add_channel_members',
  'create_channel',
  'get_channel',
  'list_channels',
  'list_notifications',
  'list_teams',
  'post_message',
  'read_messages',
  'remove_channel_member',
];
check(`tools listed: ${names.join(', ')}`, JSON.stringify(names) === JSON.stringify(expected));

// list_teams
const teams = await call('list_teams', {});
check(
  'list_teams includes Incident Response',
  teams.items.some((t: Json) => t.id === 'incident-response'),
);

// create_channel with one initial member
const channelName = 'inc0010234-customer-profile-errors';
const created = await call('create_channel', {
  name: channelName,
  description:
    'P2 CIF - Customer Information File: customer profile lookups failing with 500s since 14:05 ET.',
  members: [{ user: 'dwhitfield', reason: 'NOC shift lead, incident commander', role: 'owner' }],
});
const channelId: string = created.channel.id;
check(
  'create_channel returns id + web_url',
  /^ch_/.test(channelId) && created.channel.web_url.endsWith(`/channels/${channelId}`),
  created.channel,
);
check(
  'create_channel defaults to the Incident Response team',
  created.channel.team.id === 'incident-response',
);
check(
  'create_channel notified the initial member',
  created.notifications_sent.some((n: Json) => n.to === 'dwhitfield'),
);
const dup = await callError('create_channel', { name: `#${channelName}`, description: 'dup' });
check('duplicate create_channel is a conflict', dup.includes('already exists'), dup);

// add three people with reasons (one by email)
const added = await call('add_channel_members', {
  channel: channelName,
  members: [
    { user: 'kstreich', reason: 'support for CIF - Customer Information File' },
    { user: 'tokafor', reason: 'major incident manager' },
    { user: 'marcus.bell@keybank.example', reason: 'NOC analyst on the bridge' },
  ],
});
check(
  'add_channel_members added 3 (email resolved to username)',
  added.added.map((m: Json) => m.username).join(',') === 'kstreich,tokafor,mbell',
  added,
);
check('3 notifications sent', added.notifications_sent.length === 3, added.notifications_sent);
for (const n of added.notifications_sent) {
  const self = added.added.find((m: Json) => m.username === n.to);
  const others = added.added.filter((m: Json) => m.username !== n.to);
  const listsOthers =
    others.every((m: Json) => n.body.includes(`${m.name} (${m.reason})`)) &&
    n.body.includes('Dana Whitfield (NOC shift lead, incident commander)');
  check(
    `notification for ${n.to} states the reason and lists the others`,
    n.type === 'added_to_channel' &&
      n.body.startsWith(`You've been added to #${channelName} as ${self.reason}.`) &&
      n.body.includes("Here's who else is in the channel:") &&
      listsOthers &&
      !n.body.includes(`${self.name} (`) &&
      !n.body.includes('Incident Automation ('),
    n.body,
  );
}
console.log(`      e.g. ${added.notifications_sent[0].body}`);

const again = await call('add_channel_members', {
  channel: channelId,
  members: [{ user: 'kstreich', reason: 'again' }],
});
check(
  're-adding is idempotent',
  again.added.length === 0 &&
    again.already_members[0] === 'kstreich' &&
    again.notifications_sent.length === 0,
  again,
);
const unknown = await callError('add_channel_members', {
  channel: channelId,
  members: [{ user: 'kstreic', reason: 'typo' }],
});
check(
  'unknown user error suggests close matches',
  unknown.includes('Did you mean') && unknown.includes('kstreich'),
  unknown,
);

// get_channel
const got = await call('get_channel', { channel: channelId });
check(
  'get_channel lists 5 members with roles and reasons',
  got.members.length === 5 &&
    got.members[0].role === 'owner' &&
    got.members.find((m: Json) => m.username === 'kstreich')?.reason ===
      'support for CIF - Customer Information File',
  got.members,
);

// list_channels
const listed = await call('list_channels', { incident_only: true, q: 'inc0010234' });
check('list_channels finds the new channel', listed.items[0]?.id === channelId, listed);
const mine = await call('list_channels', { member: 'kstreich' });
check(
  'list_channels member filter',
  mine.items.some((c: Json) => c.id === channelId),
);

// post_message with a mention
const posted = await call('post_message', {
  channel: channelId,
  body: '**Update:** 500s started at 14:05 ET right after `customer-profile-api` 4.12.0. @kstreich can you confirm the rollback plan?',
  importance: 'high',
});
check(
  'post_message parsed the @mention and notified',
  posted.mentions.includes('kstreich') &&
    posted.notifications_sent.some((n: Json) => n.to === 'kstreich' && n.type === 'mention'),
  posted,
);
const replied = await call('post_message', {
  channel: channelId,
  body: 'Confirmed, rolling back to 4.11.3 now.',
  reply_to_id: posted.id,
  author: 'kstreich',
  mentions: ['dwhitfield'],
});
check(
  'threaded reply with an explicit mention',
  replied.reply_to_id === posted.id &&
    replied.notifications_sent.some((n: Json) => n.to === 'dwhitfield' && n.type === 'mention'),
  replied,
);

// read_messages
const all = await call('read_messages', { channel: channelId, limit: 100 });
check(
  'read_messages returns system + chat messages oldest first',
  all.items[0].kind === 'system' && all.items.at(-1).id === replied.id,
  all.items.map((m: Json) => m.id),
);
check(
  'system message for an add',
  all.items.some(
    (m: Json) =>
      m.kind === 'system' &&
      m.body.includes('added Kristin Streich to the channel as support for CIF'),
  ),
);
const since = await call('read_messages', { channel: channelId, since: posted.id });
check(
  'read_messages since=<message id> returns only newer',
  since.items.length === 1 && since.items[0].id === replied.id,
  since,
);
const paged = await call('read_messages', { channel: channelId, limit: 2 });
check('read_messages paginates', paged.items.length === 2 && !!paged.next_cursor, paged);

// list_notifications
const notes = await call('list_notifications', { user: 'kstreich', unread_only: true });
check(
  'list_notifications shows mention + added_to_channel for kstreich',
  notes.unread_count === 2 &&
    notes.items[0].type === 'mention' &&
    notes.items[1].type === 'added_to_channel',
  notes,
);

// remove_channel_member
const removed = await call('remove_channel_member', { channel: channelId, user: 'mbell' });
check(
  'remove_channel_member',
  removed.removed.username === 'mbell' && removed.member_count === 4,
  removed,
);
const afterRemove = await call('get_channel', { channel: channelName });
check('member gone after removal', !afterRemove.members.some((m: Json) => m.username === 'mbell'));
const removeAgain = await callError('remove_channel_member', { channel: channelId, user: 'mbell' });
check('removing a non-member explains why', removeAgain.includes('not a member'), removeAgain);

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll MCP checks passed');
process.exit(failures ? 1 : 0);
