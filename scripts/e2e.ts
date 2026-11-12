/**
 * End-to-end check of the whole simulated world. Run with everything up (`pnpm dev`):
 *
 *   pnpm e2e                                   # everything, scenarios at 6x speed
 *   pnpm e2e --scenario crd-pool-exhaustion    # one scenario
 *   pnpm e2e --skip-scenarios                  # services + MCP contracts only
 *   pnpm e2e --speed 4
 *   pnpm e2e --scenario cif-snake-case-cascade --keep   # leave the finished run's records in place
 *
 * 1. Every service answers (APIs, MCP servers, UIs, simulator).
 * 2. Every MCP tool has a description, described inputs, non-destructive annotations and a unique
 *    name across servers.
 * 3. Headline scenario, driven the way the agent would, MCP only (every MCP tool is called):
 *    cascade appears → trace through the dependency graph to the culprit → find the bad MR → open
 *    an incident and group the bankers' calls under it → open a Teams channel with the right
 *    people → open a fix MR. A human then merges it (REST, like the UI button), the simulator must
 *    see recovery, and resolving the incident resolves the calls.
 * 4. Every other scenario: symptoms land on the expected apps, the culprit stays green, alerts or
 *    the help-desk incident appear, the known fix (opened via MCP) recovers the run.
 *
 * Scenario runs reset the world first and reset it again at the end.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URLS } from '../packages/contracts/src/config';
import { createSimulatorClient } from '../packages/contracts/src/simulator/client';
import type { RunStatus, ScenarioDetail } from '../packages/contracts/src/simulator/types';

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const ONLY = flag('--scenario');
const SKIP_SCENARIOS = argv.includes('--skip-scenarios');
const SPEED = Number(flag('--speed') ?? 6);
const KEEP = argv.includes('--keep');
const HEADLINE = 'cif-snake-case-cascade';

const sim = createSimulatorClient(URLS.simulator.api);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passes = 0;
const failures: string[] = [];
let section = '';

function heading(name: string) {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function check(name: string, ok: boolean, detail?: string) {
  if (ok) passes++;
  else failures.push(`[${section}] ${name}${detail ? ` — ${detail}` : ''}`);
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ''}`);
  return ok;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

type System = 'logs' | 'servicenow' | 'gitlab' | 'teams';
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

const clients = {} as Record<System, Client>;
const toolsBySystem = {} as Record<System, string[]>;
const called = new Set<string>();

// biome-ignore lint/suspicious/noExplicitAny: tool results are free-form JSON
async function tool<T = any>(
  system: System,
  name: string,
  input: Record<string, unknown>,
): Promise<T> {
  called.add(name);
  const result = (await clients[system].callTool({ name, arguments: input })) as ToolResult;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Calls a tool and records a check; returns undefined on failure. */
// biome-ignore lint/suspicious/noExplicitAny: tool results are free-form JSON
async function step<T = any>(
  label: string,
  system: System,
  name: string,
  input: Record<string, unknown>,
  verify?: (out: T) => true | string,
): Promise<T | undefined> {
  try {
    const out = await tool<T>(system, name, input);
    const verdict = verify ? verify(out) : true;
    check(`${label} (${name})`, verdict === true, verdict === true ? undefined : verdict);
    return out;
  } catch (err) {
    check(
      `${label} (${name})`,
      false,
      err instanceof Error ? err.message.slice(0, 300) : String(err),
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 1. Services
// ---------------------------------------------------------------------------

async function checkServices() {
  heading('1. Services');
  const endpoints: [string, string][] = [
    ['simulator api', `${URLS.simulator.api}/health`],
    ['control panel ui', URLS.simulator.web],
  ];
  for (const s of ['logs', 'servicenow', 'gitlab', 'teams'] as const) {
    endpoints.push(
      [`${s} api`, `${URLS[s].api}/health`],
      [`${s} mcp`, URLS[s].mcp.replace(/\/mcp$/, '/health')],
      [`${s} ui`, URLS[s].web],
    );
  }
  await Promise.all(
    endpoints.map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        check(name, res.ok, `${url} → ${res.status}`);
      } catch (err) {
        check(name, false, `${url} → ${err instanceof Error ? err.message : err}`);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// 2. MCP contracts
// ---------------------------------------------------------------------------

async function checkMcpContracts() {
  heading('2. MCP tool contracts');
  const owner = new Map<string, string>();
  for (const system of ['logs', 'servicenow', 'gitlab', 'teams'] as const) {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(URLS[system].mcp)));
    clients[system] = client;
    const { tools } = await client.listTools();
    toolsBySystem[system] = tools.map((t) => t.name);
    const problems: string[] = [];
    for (const t of tools) {
      if (!t.description || t.description.length < 40)
        problems.push(`${t.name}: short description`);
      const props = (t.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
      for (const [key, prop] of Object.entries(props ?? {})) {
        if (!prop.description) problems.push(`${t.name}.${key}: no description`);
      }
      if (t.annotations?.destructiveHint !== false)
        problems.push(`${t.name}: destructiveHint not false`);
      if (/delete|destroy|drop|purge/i.test(t.name)) problems.push(`${t.name}: delete-style tool`);
      if (owner.has(t.name)) problems.push(`${t.name}: also on ${owner.get(t.name)}`);
      owner.set(t.name, system);
    }
    check(
      `${system}: ${tools.length} tools, described, typed, non-destructive, unique`,
      problems.length === 0,
      problems.join('; ') || undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

async function resetWorld() {
  const res = await sim.reset();
  const bad = res.systems.filter((s) => !s.ok);
  check(
    'reset all systems to baseline',
    res.ok && bad.length === 0,
    bad.map((s) => s.name).join(', '),
  );
  await waitFor(async () => (await sim.status()).engine.phase === 'running', 60_000, 1000);
}

async function runStatus(): Promise<RunStatus | null> {
  return (await sim.status()).run;
}

/** Severity>=WARNING counts per app since `since`, from the logs MCP summary. */
async function symptomsByTla(since: string, severity: 'WARNING' | 'ERROR' = 'WARNING') {
  const out = await tool<{ items: { app_tla: string; count: number; severity: string }[] }>(
    'logs',
    'summarize_errors',
    { start_time: since, severity_min: severity, limit: 100 },
  );
  const counts = new Map<string, number>();
  for (const item of out.items)
    counts.set(item.app_tla, (counts.get(item.app_tla) ?? 0) + item.count);
  return counts;
}

/** ERROR lines for one app since `since` (the culprit should have ~none). */
async function errorCount(tla: string, since: string): Promise<number> {
  const out = await tool<{ total: number }>('logs', 'search_logs', {
    app_tla: tla,
    severity_min: 'ERROR',
    start_time: since,
    limit: 1,
  });
  return out.total;
}

/** Merges like a human clicking Merge in the GitLab UI. */
async function humanMerge(project: string, iid: number) {
  const res = await fetch(
    `${URLS.gitlab.api}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}/merge`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merged_by: 'dwhitfield' }),
    },
  );
  if (!res.ok) throw new Error(`merge ${project}!${iid} → ${res.status} ${await res.text()}`);
}

async function triggerAndWaitForSymptoms(detail: ScenarioDetail) {
  // Margin for clock skew between this machine and the server (e.g. a deployed Worker).
  const since = new Date(Date.now() - 15_000).toISOString();
  const run = await sim.trigger(detail.id, { speed: SPEED });
  check(`triggered at ${SPEED}x`, run.active, run.error ?? undefined);
  check('bad MR merged into the culprit', Boolean(run.bad_mr?.web_url), run.bad_mr?.web_url);

  // In a cascade the culprit stays green; otherwise the culprit is where symptoms show.
  const expected = [...new Set(detail.impacts.map((i) => i.tla))].filter(
    (t) => detail.kind !== 'cascade' || t !== detail.answer_key.culprit_tla,
  );
  const seen = await waitFor(
    async () => {
      const counts = await symptomsByTla(since);
      return expected.every((t) => (counts.get(t) ?? 0) > 0) ? counts : undefined;
    },
    120_000,
    3000,
  );
  const counts = seen ?? (await symptomsByTla(since));
  const missing = expected.filter((t) => !(counts.get(t) ?? 0));
  check(
    `symptoms reach ${expected.length} impacted apps`,
    missing.length === 0,
    missing.length
      ? `missing ${missing.join(', ')}`
      : expected.map((t) => `${t}:${counts.get(t)}`).join(' '),
  );
  return { since, run, counts };
}

async function waitForRecovery(label: string) {
  const recovered = await waitFor(
    async () => {
      const run = await runStatus();
      return run?.phase === 'recovered' ? run : undefined;
    },
    180_000,
    2000,
  );
  check(
    `${label}: simulator detects the fix and recovers`,
    Boolean(recovered),
    recovered ? undefined : (await runStatus())?.phase,
  );
  if (recovered) {
    const open = recovered.alerts.filter((a) => !a.resolved);
    check(
      'scenario alerts auto-resolved',
      open.length === 0,
      open.map((a) => a.id).join(', ') || undefined,
    );
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// 3. Headline scenario, driven like the agent (MCP only)
// ---------------------------------------------------------------------------

async function headline(detail: ScenarioDetail) {
  heading(`3. ${detail.id} — full agent workflow over MCP`);
  await resetWorld();
  const { since } = await triggerAndWaitForSymptoms(detail);
  const culprit = detail.answer_key.culprit_tla;

  // --- Logs: what is failing, since when, and how widely?
  const summary = await step(
    'blast radius',
    'logs',
    'summarize_errors',
    { start_time: since, limit: 50 },
    (o) => (o.items?.length > 0 ? true : 'no error groups'),
  );
  const failingTlas = [
    ...new Set<string>(
      (summary?.items ?? [])
        .filter((i: { severity: string }) => i.severity !== 'WARNING')
        .map((i: { app_tla: string }) => i.app_tla),
    ),
  ];
  check(
    `culprit ${culprit} is not among failing apps`,
    !failingTlas.includes(culprit),
    failingTlas.join(' '),
  );
  const errs = await step(
    'find an error line',
    'logs',
    'search_logs',
    { filter: `labels.app_tla="OLB" AND severity>=ERROR`, start_time: since, limit: 5 },
    (o) => (o.items?.length > 0 ? true : 'no OLB errors'),
  );
  if (errs?.items?.[0]) {
    await step(
      'read its stack trace',
      'logs',
      'get_log_entry',
      { insert_id: errs.items[0].insert_id },
      (o) => (o.insertId || o.insert_id ? true : 'no entry'),
    );
  }
  await step('onset histogram', 'logs', 'get_log_histogram', {
    severity_min: 'WARNING',
    start_time: '15m',
  });
  await step('services overview', 'logs', 'list_log_services', { start_time: since, limit: 20 });
  const tail = await step(
    'tail the stream',
    'logs',
    'tail_logs',
    { severity_min: 'ERROR', limit: 5 },
    (o) => (typeof o.cursor === 'number' || typeof o.cursor === 'string' ? true : 'no cursor'),
  );
  if (tail)
    await step('long-poll for new errors', 'logs', 'tail_logs', {
      severity_min: 'ERROR',
      after_seq: Number(tail.cursor),
      wait_seconds: 5,
    });
  await waitFor(async () => (await runStatus())?.alerts.length, 60_000, 2000);
  const alerts = await step(
    'Moogsoft alerts fired',
    'logs',
    'list_alerts',
    { since: since, limit: 20 },
    (o) => (o.items?.length > 0 ? true : 'no alerts'),
  );
  const alertId = alerts?.items?.[0]?.id;
  if (alertId) await step('alert detail', 'logs', 'get_alert', { id: alertId });

  // --- ServiceNow: trace the dependency graph to a common upstream.
  const upstreamSets: string[][] = [];
  for (const tla of failingTlas
    .filter((t) => ['OLB', 'MBL', 'PAY', 'TLR', 'CRD', 'FRD'].includes(t))
    .slice(0, 4)) {
    const deps = await step(`${tla} upstream dependencies`, 'servicenow', 'get_app_dependencies', {
      tla,
      direction: 'up',
      depth: 1,
    });
    upstreamSets.push((deps?.nodes ?? []).map((n: { tla: string }) => n.tla));
  }
  const common = upstreamSets.length
    ? upstreamSets.reduce((a, b) => a.filter((t) => b.includes(t)))
    : [];
  check(
    `common upstream of failing apps includes ${culprit}`,
    common.includes(culprit),
    common.join(' '),
  );
  await step('culprit downstream fan-out', 'servicenow', 'get_app_dependencies', {
    tla: culprit,
    direction: 'down',
    depth: 1,
  });
  const app = await step(
    'culprit app owner + support',
    'servicenow',
    'get_app',
    { tla: culprit },
    (o) => (o.support_group?.id ? true : 'no support group'),
  );
  const group = await step(
    'support group on-call',
    'servicenow',
    'get_support_group',
    { group: app?.support_group?.id ?? `grp_${culprit.toLowerCase()}_support` },
    (o) => (o.on_call || o.oncall ? true : 'no on-call'),
  );
  await step('catalog search', 'servicenow', 'search_apps', { query: 'online banking', limit: 5 });
  await step('NOC group lookup', 'servicenow', 'search_support_groups', { type: 'noc', limit: 5 });
  await step('people search', 'servicenow', 'search_users', { query: 'Whitfield', limit: 5 });
  await step('user detail', 'servicenow', 'get_user', { username: 'dwhitfield' });
  await step('duplicate check', 'servicenow', 'list_incidents', {
    app_tla: culprit,
    active: true,
    limit: 10,
  });

  // --- GitLab: recent changes upstream → the bad MR.
  const commits = await step(
    `recent commits in ${culprit}`,
    'gitlab',
    'list_recent_commits',
    { tla: culprit, since: '1h' },
    (o) => (o.items?.length > 0 ? true : 'none'),
  );
  const mrs = await step(
    `MRs merged in ${culprit} since onset`,
    'gitlab',
    'list_merge_requests',
    { tla: culprit, state: 'merged', merged_after: since, limit: 10 },
    (o) =>
      o.items?.some((m: { title: string }) => m.title === detail.bad_mr.title)
        ? true
        : `bad MR "${detail.bad_mr.title}" not found`,
  );
  const badMr = mrs?.items?.find((m: { title: string }) => m.title === detail.bad_mr.title);
  const project = detail.culprit_project;
  if (badMr) {
    await step('bad MR diff', 'gitlab', 'get_merge_request', { project, iid: badMr.iid }, (o) =>
      JSON.stringify(o).includes(detail.bad_mr.edits[0]!.path.split('/').pop()!)
        ? true
        : 'diff missing edited file',
    );
    await step(
      'pipeline was green',
      'gitlab',
      'get_merge_request',
      { project, iid: badMr.iid },
      (o) => (JSON.stringify(o.pipeline ?? o).includes('success') ? true : 'pipeline not success'),
    );
  }
  const sha = commits?.items?.[0]?.id ?? commits?.items?.[0]?.sha;
  if (sha)
    await step('merge commit', 'gitlab', 'get_commit', {
      project: commits.items[0].project ?? project,
      sha,
    });
  const prodChanges = await step(
    `changes KBR promoted for ${culprit} since onset`,
    'servicenow',
    'list_change_requests',
    { app_tla: culprit, implemented_after: since, sort: '-implemented_at' },
    (o) => (o.items.length > 0 ? true : 'no production change found'),
  );
  if (prodChanges?.items[0]) {
    await step(
      'bad change request',
      'servicenow',
      'get_change_request',
      {
        number: prodChanges.items[0].number,
      },
      (o) =>
        o.merge_requests.length > 0 && o.deployments.length > 0 ? true : 'no MRs/deployments',
    );
  }
  await step('compare since yesterday', 'gitlab', 'compare_refs', {
    project,
    from: 'HEAD~1',
    to: 'main',
  });
  await step('project overview', 'gitlab', 'get_project', { project });
  await step('find project by name', 'gitlab', 'search_projects', { tla: culprit });
  await step('file tree', 'gitlab', 'get_file_tree', { project, recursive: true }, (o) =>
    JSON.stringify(o).includes(detail.fix.files[0]!) ? true : 'tree lacks the fix file',
  );
  await step('read the bad file', 'gitlab', 'get_file', { project, path: detail.fix.files[0]! });
  await step('clone the codebase', 'gitlab', 'fetch_repository', { project }, (o) =>
    o.archive_url && (o.files?.length ?? 0) > 3 ? true : 'missing files or archive_url',
  );

  // --- ServiceNow incident
  const inc = await step(
    'open incident',
    'servicenow',
    'create_incident',
    {
      short_description: `Customer profile failures across OLB, MBL, PAY after ${culprit} change`,
      description: `Downstream apps (${failingTlas.join(', ')}) failing since ${since}. Suspected cause: ${badMr?.web_url ?? 'recent change'}.`,
      app_tla: culprit,
      impact: 1,
      urgency: 1,
      category: 'application',
      contact_type: 'monitoring',
      assignment_group: app?.support_group?.id,
    },
    (o) =>
      o.priority === 1 || o.priority === '1' || String(o.priority).includes('1')
        ? true
        : `priority ${o.priority}`,
  );
  const number = inc?.number as string | undefined;

  // --- Bankers call the service desk about the same outage: group them under the incident.
  let callNumbers: string[] = [];
  if (number && detail.helpdesk.length) {
    await waitFor(
      async () => {
        const r = await runStatus();
        return (r?.helpdesk.length ?? 0) >= detail.helpdesk.length ? r : undefined;
      },
      120_000,
      2000,
    );
    const calls = await step(
      'find calls from staff about it',
      'servicenow',
      'list_incidents',
      {
        active: true,
        contact_type: ['phone', 'email', 'chat'],
        relationship: 'standalone',
        opened_after: since,
        limit: 20,
      },
      (o) =>
        (o.items?.length ?? 0) >= detail.helpdesk.length
          ? true
          : `${o.items?.length ?? 0} of ${detail.helpdesk.length} calls`,
    );
    callNumbers = (calls?.items ?? []).map((i: { number: string }) => i.number);
    if (callNumbers.length) {
      await step(
        'group the calls under the incident',
        'servicenow',
        'link_child_incidents',
        {
          parent: number,
          children: callNumbers,
          work_note: 'Branch calls are the same customer profile outage.',
          child_comment: `This is a known outage tracked in ${number}. We will update you here.`,
        },
        (o) =>
          o.child_incidents?.length === callNumbers.length
            ? true
            : `${o.child_incidents?.length} children`,
      );
      await step(
        'children of the incident',
        'servicenow',
        'list_incidents',
        { parent_incident: number },
        (o) => (o.total === callNumbers.length ? true : `total ${o.total}`),
      );
    }
  }

  // --- Teams channel with the right people
  const onCall =
    group?.on_call?.primary?.username ??
    group?.oncall?.primary?.username ??
    app?.support_group?.on_call?.primary?.username;
  const secondary = group?.on_call?.secondary?.username ?? group?.oncall?.secondary?.username;
  const channelName = `${(number ?? 'inc-e2e').toLowerCase()}-customer-profile-errors`;
  const channel = await step(
    'create incident channel',
    'teams',
    'create_channel',
    {
      name: channelName,
      description: `${number}: downstream failures after ${culprit} change`,
      members: [
        { user: 'dwhitfield', reason: 'NOC shift lead, incident commander' },
        ...(onCall
          ? [{ user: onCall, reason: `On-call support for ${culprit} - ${app?.name}` }]
          : []),
      ],
    },
    (o) => ((o.channel?.id ?? o.id) ? true : 'no channel id'),
  );
  const channelId = channel?.channel?.id ?? channel?.id ?? channelName;
  if (secondary) {
    await step('add secondary on-call', 'teams', 'add_channel_members', {
      channel: channelId,
      members: [{ user: secondary, reason: `Secondary on-call for ${culprit}` }],
    });
  }
  await step('add MIM', 'teams', 'add_channel_members', {
    channel: channelId,
    members: [{ user: 'tokafor', reason: 'Major incident manager' }],
  });
  if (onCall) {
    await step(
      'on-call got the "you\'ve been added" notification',
      'teams',
      'list_notifications',
      { user: onCall, unread_only: true },
      (o) => {
        const n = o.items?.find(
          (x: { channel_id?: string; channel_name?: string; body: string }) =>
            x.body.includes(channelName) ||
            x.channel_name === channelName ||
            x.channel_id === channelId,
        );
        if (!n) return 'no notification';
        return /who else|Dana Whitfield/.test(n.body) ? true : `body: ${n.body.slice(0, 120)}`;
      },
    );
  }
  await step('post status update', 'teams', 'post_message', {
    channel: channelId,
    body: `**${number}** opened. Root cause candidate: ${badMr?.web_url}. ${onCall ? `@${onCall} ` : ''}please confirm.`,
    importance: 'high',
  });
  await step(
    'read the channel',
    'teams',
    'read_messages',
    { channel: channelId, limit: 20 },
    (o) => (o.items?.length > 0 ? true : 'empty'),
  );
  await step('channel members', 'teams', 'get_channel', { channel: channelId });
  await step('incident channels', 'teams', 'list_channels', { incident_only: true });
  await step('teams list', 'teams', 'list_teams', {});
  await step(
    'turn the chat into a recorded call',
    'teams',
    'start_meeting',
    { channel: channelId, title: `${number} bridge` },
    (o) =>
      o.meeting?.recording && o.meeting?.transcription && o.meeting?.facilitator
        ? true
        : 'recording, transcription or facilitator is off',
  );
  await step('remove MIM after handover', 'teams', 'remove_channel_member', {
    channel: channelId,
    user: 'tokafor',
  });

  // --- Fix MR
  const fixMr = await step(
    'open fix MR with real code changes',
    'gitlab',
    'create_merge_request',
    {
      project,
      title: detail.fix.title,
      description: `${detail.fix.description}\n\nIncident: ${number}`,
      source_branch: `fix/${(number ?? 'e2e').toLowerCase()}-${culprit.toLowerCase()}`,
      changes: detail.fix.edits,
      labels: ['incident', 'hotfix'],
    },
    (o) => (o.iid && o.web_url ? true : 'no MR'),
  );
  if (fixMr) {
    await step('label it', 'gitlab', 'update_merge_request', {
      project,
      iid: fixMr.iid,
      add_labels: ['priority::1'],
    });
    await step('comment on it', 'gitlab', 'add_merge_request_note', {
      project,
      iid: fixMr.iid,
      body: `Fix for ${number}. Reverts the naming strategy change.`,
    });
  }

  // --- Back-link everything
  if (number) {
    await step('link channel, MR and alert on the incident', 'servicenow', 'update_incident', {
      number,
      state: 'in_progress',
      work_note: 'Root cause identified; fix MR open.',
      add_links: [
        {
          type: 'teams_channel',
          url: `${URLS.teams.web}/channels/${channelId}`,
          title: 'Incident channel',
        },
        ...(fixMr ? [{ type: 'merge_request', url: fixMr.web_url, title: detail.fix.title }] : []),
      ],
    });
    await step('customer-facing comment', 'servicenow', 'add_incident_note', {
      number,
      type: 'comment',
      text: 'Engineers have identified the cause and a fix is in review.',
    });
    await step('incident record', 'servicenow', 'get_incident', { number }, (o) =>
      (o.links ?? o.related_links ?? []).length >= 1 ? true : 'links missing',
    );
    const draft = await step(
      'draft the NEW Critical Incident Communication',
      'servicenow',
      'draft_incident_communication',
      {
        incident: number,
        kind: 'new',
        title: 'Customer Profile Lookups Failing',
        description: `Applications that depend on ${culprit} are returning errors. Support teams are engaged.`,
        systems_impacted: [culprit, ...failingTlas.slice(0, 4)],
      },
      (o) =>
        o.state === 'draft' &&
        /NEW - /.test(o.subject ?? '') &&
        /^GRP_CIM_Tech_P\d$/.test(o.to ?? '')
          ? true
          : `state ${o.state}, subject ${o.subject}, to ${o.to}`,
    );
    if (draft)
      await step(
        'read the draft: nobody has sent it',
        'servicenow',
        'get_incident_communication',
        { number: draft.number },
        (o) => (o.state === 'draft' && !o.sent_at ? true : `state ${o.state}`),
      );
  }
  if (alertId)
    await step('link alert to incident', 'logs', 'update_alert', {
      id: alertId,
      status: 'acknowledged',
      incident_number: number,
      note: `Tracked in ${number}`,
    });

  // --- Human merges (QV only), a change request promotes it through KBR, simulator recovers
  if (fixMr) {
    await humanMerge(project, fixMr.iid).then(
      () => check('human merges the fix MR (GitLab UI action)', true),
      (err) => check('human merges the fix MR (GitLab UI action)', false, String(err)),
    );
    await sleep(8_000);
    const qv = await runStatus();
    check(
      'merged fix is only in QV: production still broken',
      qv?.phase === 'degrading' && qv.fix_on_main_at !== null,
      `${qv?.phase} / fix_on_main_at ${qv?.fix_on_main_at}`,
    );
    const chg = await step(
      'raise the change request (scheduled for later)',
      'servicenow',
      'create_change_request',
      {
        short_description: `${culprit} - ${detail.fix.title} (${number})`.slice(0, 160),
        app_tla: culprit,
        merge_requests: [`${project}!${fixMr.iid}`],
        planned_start: '+1h',
        type: 'emergency',
        description: `Fix for ${number}.`,
        related_incidents: number ? [number] : undefined,
      },
      (o) => (o.state === 'scheduled' ? true : `state ${o.state}`),
    );
    if (chg) {
      await step('pull it in: planned start now', 'servicenow', 'update_change_request', {
        number: chg.number,
        planned_start: 'now',
        work_note: 'Incident fix: promote now.',
      });
    }
    const recovered = await waitForRecovery(detail.id);
    if (chg) {
      await step(
        'KBR implemented the change',
        'servicenow',
        'get_change_request',
        { number: chg.number },
        (o) => (o.state === 'closed' && o.deployments.length > 0 ? true : `state ${o.state}`),
      );
    }
    if (recovered) {
      await step('tag the hotfix release', 'gitlab', 'create_tag', {
        project,
        tag_name: `hotfix-${Date.now()}`,
        ref: 'main',
        message: `Fix for ${number}`,
      });
      const after = new Date(Date.now() + 3000).toISOString();
      await sleep(10_000);
      const residual = await symptomsByTla(after, 'ERROR');
      const stillFailing = [...residual.entries()].filter(
        ([t, c]) => failingTlas.includes(t) && c > 5,
      );
      check(
        'errors stop after recovery',
        stillFailing.length === 0,
        stillFailing.map(([t, c]) => `${t}:${c}`).join(' ') || undefined,
      );
    }
    if (number) {
      await step('resolve incident', 'servicenow', 'update_incident', {
        number,
        state: 'resolved',
        close_code: 'Resolved by change',
        close_notes: `Fixed by ${fixMr.web_url}`,
      });
      if (callNumbers[0]) {
        const call = await tool('servicenow', 'get_incident', { number: callNumbers[0] });
        check(
          "resolving the incident resolved the bankers' calls",
          call.state === 'resolved',
          call.state,
        );
      }

      // --- Once resolved: the Resolution section, the problem record, the chat's name, the all-clear
      await step(
        'fill out the Resolution section',
        'servicenow',
        'update_incident',
        {
          number,
          cause_code: 'Change',
          ...(chg ? { resolved_by_change: chg.number } : {}),
          service_restored_at: 'now',
          root_cause: 'A naming strategy change broke the response contract callers rely on.',
          client_impact: 'Clients could not load their profile in online and mobile banking.',
          employee_impact: 'Branch staff could not look up customers.',
        },
        (o) => (o.cause_code === 'Change' && o.service_restored_at ? true : 'fields not set'),
      );
      const prb = await step(
        'open the problem record for the 8 AM stand-up',
        'servicenow',
        'create_problem',
        {
          short_description: `${culprit} change broke its callers`,
          incidents: [number],
          cause_code: 'Change',
          root_cause: 'A naming strategy change broke the response contract callers rely on.',
          mitigation_plan: `Reverted by ${fixMr.web_url}.`,
          standup: true,
        },
        (o) =>
          /^PRB\d+$/.test(o.number ?? '') && o.standup_date
            ? true
            : `number ${o.number}, stand-up ${o.standup_date}`,
      );
      if (prb) {
        await step(
          'add action items to the problem',
          'servicenow',
          'update_problem',
          {
            number: prb.number,
            action_items: '- Add a contract test between the service and its callers',
            work_note: 'Action items added for the stand-up.',
          },
          (o) => (String(o.action_items ?? '').includes('contract test') ? true : 'not saved'),
        );
        await step(
          'problem record links the incident',
          'servicenow',
          'get_problem',
          { number: prb.number },
          (o) =>
            (o.incidents ?? []).some((i: unknown) => JSON.stringify(i).includes(number))
              ? true
              : 'incident missing',
        );
        await step(
          "it is on the next stand-up's agenda",
          'servicenow',
          'list_problems',
          { standup: 'next' },
          (o) =>
            o.items?.some((p: { number: string }) => p.number === prb.number)
              ? true
              : 'not on the agenda',
        );
        await step(
          'rename the chat with the problem number',
          'teams',
          'update_channel',
          {
            channel: channelId,
            name: `${number.toLowerCase()}-${prb.number.toLowerCase()}-customer-profile-errors`,
          },
          (o) =>
            String(o.name ?? o.channel?.name).includes(prb.number.toLowerCase())
              ? true
              : 'not renamed',
        );
      }
      await step('end the call', 'teams', 'end_meeting', { channel: channelId }, (o) =>
        o.meeting?.ended_at ? true : 'still running',
      );
      await step(
        'draft the RESTORED Critical Incident Communication',
        'servicenow',
        'draft_incident_communication',
        {
          incident: number,
          kind: 'restored',
          description: `Applications that depend on ${culprit} returned errors until a corrective change was promoted.`,
          cause: 'A change to the response format of an upstream service.',
          resolution_activities:
            'The change was reverted and promoted through an emergency change.',
        },
        (o) => (/RESTORED - /.test(o.subject ?? '') && o.resolved ? true : `subject ${o.subject}`),
      );
      await step(
        'both communications are on the incident, unsent',
        'servicenow',
        'list_incident_communications',
        { incident: number },
        (o) =>
          o.items?.length === 2 && o.items.every((x: { state: string }) => x.state === 'draft')
            ? true
            : `${o.items?.length} communications`,
      );
    }
  }

  // Coverage: every tool on every server was exercised.
  const all = Object.values(toolsBySystem).flat();
  const missed = all.filter((t) => !called.has(t));
  check(
    `all ${all.length} MCP tools exercised`,
    missed.length === 0,
    missed.join(', ') || undefined,
  );
}

// ---------------------------------------------------------------------------
// 4. Other scenarios
// ---------------------------------------------------------------------------

async function otherScenario(detail: ScenarioDetail) {
  heading(`4. ${detail.id} (${detail.kind})`);
  await resetWorld();
  const culprit = detail.answer_key.culprit_tla;
  const { since } = await triggerAndWaitForSymptoms(detail);

  if (detail.kind === 'cascade') {
    const errors = await errorCount(culprit, since);
    check(`culprit ${culprit} stays green`, errors <= 2, `${errors} ERROR lines`);
  } else if (detail.kind === 'single-app') {
    const errors = await errorCount(culprit, since);
    check(`culprit ${culprit} is the one failing`, errors > 0, `${errors} ERROR lines`);
  }

  if (detail.helpdesk.length) {
    const run = await waitFor(async () => {
      const r = await runStatus();
      return r?.helpdesk.length ? r : undefined;
    }, 90_000);
    const number = run?.helpdesk[0]?.number;
    check('help desk call opened a ServiceNow incident', Boolean(number), number);
    if (number) {
      const inc = await tool('servicenow', 'get_incident', { number });
      check(
        'incident came in by phone, unassigned to an app',
        inc.contact_type === 'phone' && !inc.app?.tla,
        `${inc.contact_type} / ${inc.app?.tla ?? 'no app'}`,
      );
    }
    if (detail.helpdesk.length > 1) {
      const all = await waitFor(async () => {
        const r = await runStatus();
        return (r?.helpdesk.length ?? 0) >= detail.helpdesk.length ? r : undefined;
      }, 120_000);
      const calls = (all?.helpdesk ?? []).map((h) => h.number);
      check(
        `${detail.helpdesk.length} branches called in`,
        calls.length === detail.helpdesk.length,
      );
      if (calls.length > 1) {
        const parent = await tool('servicenow', 'create_incident', {
          short_description: `${culprit} - same problem reported by ${calls.length} branches`,
          app_tla: culprit,
          impact: 1,
          urgency: 2,
          child_incidents: calls,
        });
        check(
          'calls grouped under one parent',
          parent.child_incidents?.length === calls.length,
          parent.number,
        );
      }
    }
  }
  if (detail.alerts.length) {
    const run = await waitFor(async () => {
      const r = await runStatus();
      return r?.alerts.length ? r : undefined;
    }, 90_000);
    check(
      'Moogsoft alerts raised',
      Boolean(run?.alerts.length),
      run?.alerts.map((a) => `${a.app_tla}:${a.severity}`).join(' '),
    );
  }

  const mrs = await tool('gitlab', 'list_merge_requests', {
    tla: culprit,
    state: 'merged',
    merged_after: since,
  });
  const badMr = mrs.items?.find((m: { title: string }) => m.title === detail.bad_mr.title);
  check(
    'bad MR visible in GitLab with a green pipeline',
    Boolean(badMr) && String(badMr.pipeline).includes('success'),
    badMr?.web_url,
  );

  const fixMr = await tool('gitlab', 'create_merge_request', {
    project: detail.culprit_project,
    title: detail.fix.title,
    description: detail.fix.description,
    source_branch: `fix/e2e-${detail.id}`,
    changes: detail.fix.edits,
    labels: ['incident'],
  }).catch((err) => {
    check('fix MR opens via MCP', false, String(err));
    return undefined;
  });
  if (fixMr) {
    check('fix MR opens via MCP', true, fixMr.web_url);
    await humanMerge(detail.culprit_project, fixMr.iid);
    await tool('servicenow', 'create_change_request', {
      short_description: detail.fix.title.slice(0, 160),
      app_tla: culprit,
      merge_requests: [`${detail.culprit_project}!${fixMr.iid}`],
      planned_start: 'now',
      type: 'emergency',
    }).then(
      (c) => check('fix change request raised', c.state === 'scheduled', c.number),
      (err) => check('fix change request raised', false, String(err)),
    );
    await waitForRecovery(detail.id);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  await checkServices();
  await checkMcpContracts();
  if (!SKIP_SCENARIOS) {
    const list = await sim.listScenarios();
    check('scenarios registered', list.length >= 5, list.map((s) => s.id).join(', '));
    const details = await Promise.all(list.map((s) => sim.getScenario(s.id)));
    const head = details.find((d) => d.id === HEADLINE);
    if (head && (!ONLY || ONLY === HEADLINE)) await headline(head);
    for (const detail of details) {
      if (detail.id === HEADLINE || (ONLY && ONLY !== detail.id)) continue;
      await otherScenario(detail);
    }
    if (!KEEP) {
      heading('Cleanup');
      await resetWorld();
    }
  }
  for (const client of Object.values(clients)) await client.close().catch(() => {});
  const secs = Math.round((Date.now() - started) / 1000);
  const verdict = failures.length === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`\n${verdict} ${passes} passed, ${failures.length} failed in ${secs}s`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
