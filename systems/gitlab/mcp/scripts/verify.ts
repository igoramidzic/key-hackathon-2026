/**
 * End-to-end check of every GitLab MCP tool through a real MCP client.
 * Needs gitlab-api (4003) and gitlab-mcp (5003) running:
 *   pnpm --filter @sim/gitlab-mcp exec tsx scripts/verify.ts
 */
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URLS } from '@sim/contracts';
import { createGitlabClient } from '@sim/contracts/gitlab';

const MCP_URL = process.env.GITLAB_MCP_URL ?? URLS.gitlab.mcp;
const rest = createGitlabClient(process.env.GITLAB_API_URL ?? URLS.gitlab.api);
const HERO_TLAS = [
  'ATH',
  'GLD',
  'CIF',
  'DEP',
  'NTF',
  'FRD',
  'ABA',
  'ACH',
  'WIR',
  'PAY',
  'BPY',
  'CRD',
  'TLR',
  'OLB',
  'MBL',
];

/** A generated (non-hero) Spring service with upstream clients, so scenario repos stay untouched. */
async function pickProject(): Promise<string> {
  const page = await rest.listProjects({
    stack: 'java-spring',
    kind: 'service',
    order_by: 'id',
    sort: 'asc',
    limit: 100,
  });
  for (const p of page.items) {
    if (HERO_TLAS.includes(p.tla)) continue;
    const yml = await rest.getRawFile(p.path_with_namespace, 'src/main/resources/application.yml');
    if (yml?.includes('base-url:')) return p.path_with_namespace;
  }
  throw new Error('No suitable project found');
}
const PROJECT = process.env.VERIFY_PROJECT ?? (await pickProject());
console.log(`project under test: ${PROJECT}`);

const client = new Client({ name: 'gitlab-verify', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

let failures = 0;
const called = new Set<string>();

async function call(
  name: string,
  args: Record<string, unknown>,
  expectError = false,
  // biome-ignore lint/suspicious/noExplicitAny: tool results are free-form JSON
): Promise<any> {
  called.add(name);
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
  const ok = expectError ? res.isError === true : res.isError !== true;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${expectError ? ' (expected error)' : ''}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`,
  );
  if (res.isError) return text;
  return JSON.parse(text);
}

function check(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
}

const init = client.getInstructions();
check('server instructions present', Boolean(init?.includes('keybank/<TLA>00')));
const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

const search = await call('search_projects', { tla: PROJECT.split('/')[1]!.slice(0, 3) });
check(
  'search_projects finds the project by TLA',
  search.items.some((p: { path: string }) => p.path === PROJECT),
);
await call('search_projects', { query: 'payments', limit: 3 });

const proj = await call('get_project', { project: PROJECT });
check(
  'get_project has upstream_tlas',
  Array.isArray(proj.upstream_tlas) && proj.recent_commits.length > 0,
);

const groupCommits = await call('list_recent_commits', { tla: 'PAY', since: '30d', limit: 5 });
check('list_recent_commits by tla', groupCommits.items.length > 0);
const commits = await call('list_recent_commits', { project: PROJECT, since: '400d', limit: 5 });
check('list_recent_commits by project has stats', commits.items[0]?.additions !== undefined);
await call('list_recent_commits', {}, true);

const sha =
  commits.items.find((c: { merge_commit?: boolean }) => c.merge_commit)?.sha ??
  commits.items[0].sha;
const commit = await call('get_commit', { project: PROJECT, sha: sha.slice(0, 8) });
check('get_commit returns diffs', commit.diffs.length > 0);

const from = commits.items[commits.items.length - 1].sha;
const cmp = await call('compare_refs', { project: PROJECT, from, to: 'main' });
check('compare_refs returns commits and diffs', cmp.commits.length > 0 && cmp.diffs.length > 0);

const mrs = await call('list_merge_requests', {
  tla: 'PAY',
  state: 'merged',
  merged_after: '400d',
});
check('list_merge_requests merged', mrs.items.length > 0);
const mr = await call('get_merge_request', {
  project: mrs.items[0].project,
  iid: mrs.items[0].iid,
});
check('get_merge_request has changes', mr.changes.length > 0 && Array.isArray(mr.notes));

const tree = await call('get_file_tree', { project: PROJECT });
check(
  'get_file_tree lists application.yml',
  tree.entries.includes('src/main/resources/application.yml'),
);
await call('get_file_tree', { project: PROJECT, path: 'src/main', recursive: false });

const file = await call('get_file', {
  project: PROJECT,
  path: 'src/main/resources/application.yml',
});
check('get_file returns content', file.content.includes('upstream:'));

const repo = await call('fetch_repository', { project: PROJECT });
check('fetch_repository returns all files', repo.files.length === tree.entries.length);
const listing = execFileSync('sh', ['-c', `curl -sL '${repo.archive_url}' | tar tz`]).toString();
check('archive_url is a real tar.gz', listing.includes('src/main/resources/application.yml'));

// A real code change: raise the first upstream's read timeout by 500ms.
const lines = (file.content as string).split('\n');
const at = lines.findIndex((l) => l.includes('base-url:'));
const block = lines.slice(at, at + 3).join('\n');
const m = block.match(/read-timeout: (\d+)(ms|s)/)!;
const current = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
const fixed = block.replace(/read-timeout: .*/, `read-timeout: ${current + 500}ms`);
const branch = `fix/verify-${Date.now()}`;
const created = await call('create_merge_request', {
  project: PROJECT,
  title: `fix: raise upstream read timeout to ${current + 500}ms (verify script)`,
  description: '## Root cause\nVerification run.\n',
  source_branch: branch,
  labels: ['incident'],
  changes: [
    { path: 'src/main/resources/application.yml', find: block, replace: fixed },
    { path: `docs/incidents/${branch.replace(/\//g, '-')}.md`, content: `# Verify\n\n${fixed}\n` },
  ],
});
check(
  'create_merge_request has diff',
  created.changes?.length === 2 && created.web_url?.includes('/-/merge_requests/'),
);
await call(
  'create_merge_request',
  {
    project: PROJECT,
    title: 'bad',
    description: 'x',
    source_branch: `${branch}-bad`,
    changes: [
      {
        path: 'src/main/resources/application.yml',
        find: 'text that is not in the file',
        replace: 'x',
      },
    ],
  },
  true,
);

const updated = await call('update_merge_request', {
  project: PROJECT,
  iid: created.iid,
  add_labels: ['P2', 'gitlab-verify'],
  description: '## Root cause\nVerification run (updated).',
});
check(
  'update_merge_request labels',
  updated.labels.includes('gitlab-verify') && updated.labels.includes('incident'),
);
await call('add_merge_request_note', {
  project: PROJECT,
  iid: created.iid,
  body: 'Evidence: see INC0000000.',
});
await call('create_tag', {
  project: PROJECT,
  tag_name: `verify-${Date.now()}`,
  ref: 'main',
  message: 'verify',
});

// Humans merge in the UI: do it through REST and confirm main has the fix.
const merged = await rest.mergeMergeRequest(PROJECT, created.iid, { merged_by: 'dwhitfield' });
check('REST merge', merged.state === 'merged');
const raw = await rest.getRawFile(PROJECT, 'src/main/resources/application.yml');
check('getRawFile sees the merged change', Boolean(raw?.includes(fixed)));
check(
  'getRawFile returns null for missing files',
  (await rest.getRawFile(PROJECT, 'nope.txt')) === null,
);

const expected = [
  'search_projects',
  'get_project',
  'list_recent_commits',
  'get_commit',
  'compare_refs',
  'list_merge_requests',
  'get_merge_request',
  'get_file_tree',
  'get_file',
  'fetch_repository',
  'create_merge_request',
  'update_merge_request',
  'add_merge_request_note',
  'create_tag',
];
check(
  `all ${expected.length} tools listed`,
  expected.every((t) => tools.some((x) => x.name === t)),
);
check(
  'every tool called',
  expected.every((t) => called.has(t)),
);

await client.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
