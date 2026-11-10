import type { SystemName } from '@sim/contracts';
import {
  AppShell,
  Card,
  CardContent,
  cn,
  Input,
  NativeSelect,
  Spinner,
  StatusBadge,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sim/ui';
import { BookOpen, Download, Radio, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { HeaderActions } from '../Header';
import { TopNav, useStatus } from '../lib';
import {
  CopyButton,
  InlineCode,
  RichText,
  Section,
  ServiceLogo,
  SnippetTabs,
  ToolKindBadge,
  ToolLink,
  toolPath,
} from './bits';
import {
  endpoints,
  isSystem,
  SERVERS,
  type ServerInfo,
  serverLabel,
  toolKind,
  useAllServers,
  useServer,
} from './mcp';
import { StreamPage } from './StreamPage';
import { connectSnippets } from './snippets';
import { ServerDown, ToolPage } from './ToolPage';
import { TargetProvider, TargetToggle, useTarget } from './target';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** /docs/*: the agent developer docs, with the live tool reference in the sidebar. */
export function DocsPage() {
  const status = useStatus();
  return (
    <AppShell
      system="simulator"
      nav={<TopNav />}
      actions={<HeaderActions status={status.data} offline={status.isError} />}
      sidebar={<DocsSidebar />}
      systemLinks={false}
    >
      <TargetProvider>
        <DocsMobileNav />
        <Routes>
          <Route index element={<Overview />} />
          <Route path="stream" element={<StreamPage />} />
          <Route path=":system" element={<ServerRoute />} />
          <Route path=":system/:tool" element={<ToolRoute />} />
        </Routes>
      </TargetProvider>
    </AppShell>
  );
}

function ServerRoute() {
  const { system } = useParams();
  if (!isSystem(system)) return <NotFound />;
  return <ServerPage system={system} />;
}

function ToolRoute() {
  const { system, tool } = useParams();
  if (!isSystem(system) || !tool) return <NotFound />;
  return <ToolPage system={system} name={tool} />;
}

function NotFound() {
  return (
    <p className="text-muted-foreground text-sm">
      Nothing here.{' '}
      <Link to="/docs" className="underline">
        Back to the docs
      </Link>
      .
    </p>
  );
}

const sideLink = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2 px-3 py-1 text-sm',
    isActive
      ? 'bg-muted font-medium text-foreground'
      : 'text-muted-foreground hover:text-foreground',
  );

/** Left pane: guides, then every server with its live tool list (filterable). */
function DocsSidebar() {
  const servers = useAllServers();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  return (
    <div className="grid gap-4 py-3">
      <div className="relative px-3">
        <Search className="absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter tools"
          className="h-8 pl-7 text-sm"
          aria-label="Filter tools"
        />
      </div>
      {!needle && (
        <nav aria-label="Guides" className="grid">
          <NavLink end to="/docs" className={sideLink}>
            <BookOpen className="size-3.5" />
            Getting started
          </NavLink>
          <NavLink to="/docs/stream" className={sideLink}>
            <Radio className="size-3.5" />
            Log stream &amp; simulator API
          </NavLink>
        </nav>
      )}
      {servers.map(({ system, label, query }) => {
        const tools = (query.data?.tools ?? []).filter(
          (t) =>
            !needle || t.name.includes(needle) || t.description?.toLowerCase().includes(needle),
        );
        if (needle && tools.length === 0) return null;
        return (
          <nav key={system} aria-label={`${label} tools`} className="grid">
            <NavLink
              end
              to={`/docs/${system}`}
              className={({ isActive }) =>
                cn(sideLink({ isActive }), 'font-semibold text-[11px] uppercase tracking-wider')
              }
            >
              <ServiceLogo system={system} />
              {label}
              <span className="ml-auto flex items-center gap-1.5 font-normal text-muted-foreground tabular-nums">
                {query.isError && <StatusDot tone="negative" />}
                {query.data ? query.data.tools.length : ''}
              </span>
            </NavLink>
            {tools.map((t) => (
              <NavLink key={t.name} to={toolPath(system, t.name)} className={sideLink}>
                <span className="truncate pl-4 font-mono text-[12.5px]">{t.name}</span>
                <span className="ml-auto">
                  <ToolKindBadge tool={t} compact />
                </span>
              </NavLink>
            ))}
          </nav>
        );
      })}
    </div>
  );
}

/** Small screens have no sidebar: a select jumps between pages instead. */
function DocsMobileNav() {
  const servers = useAllServers();
  const navigate = useNavigate();
  const path = useLocation().pathname;
  return (
    <NativeSelect
      className="mb-4 w-full md:hidden"
      value={path}
      onChange={(e) => navigate(e.target.value)}
      aria-label="Docs page"
    >
      <option value="/docs">Getting started</option>
      <option value="/docs/stream">Log stream &amp; simulator API</option>
      {servers.map(({ system, label, query }) => (
        <optgroup key={system} label={label}>
          <option value={`/docs/${system}`}>{label} overview</option>
          {query.data?.tools.map((t) => (
            <option key={t.name} value={toolPath(system, t.name)}>
              {t.name}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

// ---------------------------------------------------------------------------
// Getting started
// ---------------------------------------------------------------------------

const WORKFLOW: { step: string; goal: string; tools: [SystemName, string][]; note?: string }[] = [
  {
    step: 'Detect',
    goal: 'Notice that something is wrong.',
    tools: [
      ['logs', 'list_alerts'],
      ['logs', 'summarize_errors'],
      ['servicenow', 'list_incidents'],
    ],
    note: 'Or run your own rules on the live log stream. In the help-desk scenario the trigger is a phone incident in ServiceNow.',
  },
  {
    step: 'Scope',
    goal: 'Which apps fail, and since when.',
    tools: [
      ['logs', 'summarize_errors'],
      ['logs', 'get_log_histogram'],
      ['logs', 'search_logs'],
      ['logs', 'get_log_entry'],
    ],
  },
  {
    step: 'Trace',
    goal: 'Find the upstream app the failing apps share.',
    tools: [
      ['servicenow', 'get_app'],
      ['servicenow', 'get_app_dependencies'],
    ],
    note: 'In cascades the culprit looks healthy: it keeps returning 200s.',
  },
  {
    step: 'Find the change',
    goal: 'Which recent merge broke it.',
    tools: [
      ['gitlab', 'list_merge_requests'],
      ['gitlab', 'get_merge_request'],
      ['gitlab', 'list_recent_commits'],
      ['gitlab', 'get_file'],
    ],
    note: 'Its pipeline was green, and red-herring merges land nearby.',
  },
  {
    step: 'Open the incident',
    goal: 'Record it against the culprit app.',
    tools: [['servicenow', 'create_incident']],
  },
  {
    step: 'Assemble people',
    goal: 'The right people in one channel, each with a reason.',
    tools: [
      ['servicenow', 'get_support_group'],
      ['teams', 'create_channel'],
      ['teams', 'add_channel_members'],
      ['teams', 'post_message'],
    ],
  },
  {
    step: 'Propose the fix',
    goal: 'Branch, commit and merge request in one call.',
    tools: [
      ['gitlab', 'create_merge_request'],
      ['gitlab', 'add_merge_request_note'],
    ],
    note: 'There is no merge tool: a human merges in the GitLab UI.',
  },
  {
    step: 'Link and close',
    goal: 'Cross-link everything, confirm recovery, resolve.',
    tools: [
      ['servicenow', 'update_incident'],
      ['logs', 'update_alert'],
      ['logs', 'tail_logs'],
    ],
  },
];

function Overview() {
  const { target } = useTarget();
  const servers = useAllServers();
  const s = useMemo(() => connectSnippets(target), [target]);
  const ep = endpoints(target);

  return (
    <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-10">
      <div className="grid gap-2">
        <h1 className="font-semibold text-2xl tracking-tight">Build the incident agent</h1>
        <p className="max-w-3xl text-base text-muted-foreground">
          Your agent works the simulated estate through four MCP servers, plus an optional live log
          stream for rule-based detection. The tool reference in the sidebar is read live from the
          running servers, so it always matches what your agent will see. Every tool has a{' '}
          <strong className="text-foreground">Try it</strong> console.
        </p>
      </div>

      <Section
        title="Endpoints"
        description="Streamable HTTP, stateless, JSON responses, no auth. Local needs pnpm dev; hosted is shared with everyone using the live demo."
      >
        <div className="flex justify-end">
          <TargetToggle />
        </div>
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Server</TableHead>
                  <TableHead>MCP URL</TableHead>
                  <TableHead className="hidden sm:table-cell">Status here</TableHead>
                  <TableHead className="pr-4 text-right">Tools</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map(({ system, label, blurb, query }) => (
                  <TableRow key={system}>
                    <TableCell className="pl-4 align-top">
                      <Link
                        to={`/docs/${system}`}
                        className="inline-flex items-center gap-2 font-medium hover:underline"
                      >
                        <ServiceLogo system={system} />
                        {label}
                      </Link>
                      <div className="hidden max-w-xs whitespace-normal text-muted-foreground text-xs lg:block">
                        {blurb}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <span className="inline-flex items-center gap-1">
                        <InlineCode className="text-xs">{ep.mcp(system)}</InlineCode>
                        <CopyButton text={ep.mcp(system)} />
                      </span>
                    </TableCell>
                    <TableCell className="hidden align-top sm:table-cell">
                      {query.isError ? (
                        <StatusBadge tone="negative" dot>
                          Unreachable
                        </StatusBadge>
                      ) : query.data ? (
                        <StatusBadge tone="positive" dot>
                          Up · v{query.data.version}
                        </StatusBadge>
                      ) : (
                        <StatusBadge dot>Checking</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right align-top tabular-nums">
                      {query.data?.tools.length ?? '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Connect"
        description="Pick your client. Every snippet points at the endpoints above."
      >
        <SnippetTabs
          tabs={[
            {
              id: 'claude-code',
              label: 'Claude Code',
              code: s.claudeCli,
              language: 'bash',
              note: (
                <>
                  Sessions opened in this repo already get the local servers from{' '}
                  <InlineCode>.mcp.json</InlineCode>.
                </>
              ),
            },
            { id: 'mcp-json', label: '.mcp.json', code: s.mcpJson, language: 'json' },
            {
              id: 'agent-sdk',
              label: 'Claude Agent SDK',
              code: s.agentSdk,
              language: 'typescript',
            },
            { id: 'adk', label: 'Google ADK', code: s.adk, language: 'python' },
            { id: 'mcp-sdk', label: 'MCP SDK', code: s.rawSdk, language: 'typescript' },
            { id: 'curl', label: 'curl', code: s.curl, language: 'bash' },
            {
              id: 'inspector',
              label: 'MCP Inspector',
              code: s.inspector,
              language: 'bash',
              note: 'The official MCP debugging UI. Useful to see exactly what a client receives.',
            },
          ]}
        />
        <p className="text-muted-foreground text-sm">
          Hosted model APIs whose MCP connector runs in the provider's cloud can't reach{' '}
          <InlineCode>localhost</InlineCode>: use the hosted endpoints, run the agent locally, or
          tunnel the ports.
        </p>
      </Section>

      <Section
        title="How an incident run goes"
        description="What a good agent does, step by step, and the tools for each step. scripts/e2e.ts performs every step with real calls if you want exact argument shapes."
      >
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40 pl-4">Step</TableHead>
                  <TableHead>Goal</TableHead>
                  <TableHead className="pr-4">Tools</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {WORKFLOW.map((w, i) => (
                  <TableRow key={w.step} className="align-top">
                    <TableCell className="pl-4 font-medium">
                      <span className="mr-2 text-muted-foreground tabular-nums">{i + 1}</span>
                      {w.step}
                    </TableCell>
                    <TableCell className="whitespace-normal text-sm">
                      {w.goal}
                      {w.note && (
                        <div className="mt-0.5 text-muted-foreground text-xs">{w.note}</div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal pr-4">
                      <div className="flex flex-wrap gap-1">
                        {w.tools.map(([sys, name]) => (
                          <ToolLink key={`${sys}.${name}`} system={sys} name={name} />
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="The dev loop"
        description="Reset, trigger a scenario, run your agent, merge its MR in GitLab, and check that the run recovers."
      >
        <SnippetTabs
          tabs={[
            {
              id: 'cli',
              label: 'CLI',
              language: 'bash',
              code: `pnpm sim reset
pnpm sim trigger cif-snake-case-cascade --speed 4
# ... run your agent, then merge its MR in the GitLab UI ...
pnpm sim status   # Run phase "recovered" = success`,
            },
            {
              id: 'rest',
              label: 'REST (for a test harness)',
              language: 'bash',
              code: `curl -X POST ${ep.simApi}/api/reset
curl -X POST ${ep.simApi}/api/scenarios/cif-snake-case-cascade/trigger \\
  -H 'content-type: application/json' -d '{"speed":4}'
curl -s ${ep.simApi}/api/status   # .run.phase == "recovered"`,
            },
          ]}
        />
        <p className="text-muted-foreground text-sm">
          Or use the{' '}
          <Link to="/" className="underline">
            control panel
          </Link>
          . Scenarios from easiest to hardest: <InlineCode>crd-pool-exhaustion</InlineCode>,{' '}
          <InlineCode>tlr-business-date-helpdesk</InlineCode>,{' '}
          <InlineCode>ath-token-ttl-cascade</InlineCode>,{' '}
          <InlineCode>aba-checksum-cascade</InlineCode>,{' '}
          <InlineCode>cif-snake-case-cascade</InlineCode>.
        </p>
      </Section>

      <Section title="Ground rules">
        <ul className="grid max-w-3xl list-disc gap-1.5 pl-5 text-sm leading-6">
          <li>
            The agent finds the root cause from the systems. Never give it the simulator API: it
            serves the answer key (culprit, bad MR, fix). Keep that in your test harness.
          </li>
          <li>
            Writes act as <InlineCode>svc_incident_auto</InlineCode> ("Incident Automation") unless
            you pass an author. Usernames are the same in ServiceNow, GitLab and Teams.
          </li>
          <li>
            Useful people: <InlineCode>dwhitfield</InlineCode> (NOC shift lead, incident commander),{' '}
            <InlineCode>tokafor</InlineCode> (major incident manager),{' '}
            <InlineCode>pnatarajan</InlineCode> (service desk), plus each app's on-call from its
            support group.
          </li>
          <li>
            There are no delete or merge tools. Every entity returns a{' '}
            <InlineCode>web_url</InlineCode> to link from incidents and messages.
          </li>
          <li>
            Lists page with <InlineCode>limit</InlineCode> and <InlineCode>cursor</InlineCode> and
            return <InlineCode>next_cursor</InlineCode>. Times accept ISO 8601 or relative values
            like <InlineCode>"15m"</InlineCode>.
          </li>
        </ul>
      </Section>

      <Section
        title="Machine-readable"
        description="Every server's tool definitions (names, descriptions, JSON Schemas, annotations) in one file, as returned by tools/list. Handy for codegen, evals or offline reference."
      >
        <div>
          <DownloadTools servers={servers.map((x) => x.query.data)} />
        </div>
      </Section>
    </div>
  );
}

function DownloadTools({ servers }: { servers: (ServerInfo | undefined)[] }) {
  const ready = servers.filter((s): s is ServerInfo => Boolean(s));
  const download = () => {
    const doc = Object.fromEntries(
      ready.map((s) => [
        s.system,
        { title: s.title, version: s.version, instructions: s.instructions, tools: s.tools },
      ]),
    );
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sim-mcp-tools.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <button
      type="button"
      onClick={download}
      disabled={ready.length === 0}
      className="inline-flex h-8 items-center gap-1.5 border bg-background px-2.5 text-sm hover:bg-muted disabled:opacity-50"
    >
      <Download className="size-3.5" />
      sim-mcp-tools.json
      <span className="text-muted-foreground text-xs">
        ({ready.reduce((n, s) => n + s.tools.length, 0)} tools)
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// One server
// ---------------------------------------------------------------------------

function ServerPage({ system }: { system: SystemName }) {
  const server = useServer(system);
  const { target } = useTarget();
  const url = endpoints(target).mcp(system);
  const meta = SERVERS.find((s) => s.system === system)!;
  return (
    <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-8">
      <div className="grid gap-2">
        <h1 className="flex items-center gap-3 font-semibold text-2xl tracking-tight">
          <ServiceLogo system={system} size="lg" />
          {serverLabel(system)} MCP server
        </h1>
        <p className="text-base text-muted-foreground">{meta.blurb}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1">
            <InlineCode className="text-xs">{url}</InlineCode>
            <CopyButton text={url} />
          </span>
          <TargetToggle />
        </div>
      </div>
      {server.isLoading && <Spinner label="Asking the server" />}
      {server.isError && <ServerDown system={system} error={server.error} />}
      {server.data && (
        <>
          <Section
            title="Server instructions"
            description="Sent to every client on initialize; most clients put this in the model's context."
          >
            <Card>
              <CardContent className="text-sm leading-6">
                <RichText text={server.data.instructions || 'None.'} />
              </CardContent>
            </Card>
          </Section>
          <Section title={`Tools (${server.data.tools.length})`}>
            <Card className="py-0">
              <CardContent className="px-0">
                <Table>
                  <TableBody>
                    {server.data.tools.map((t) => (
                      <TableRow key={t.name} className="align-top">
                        <TableCell className="w-64 pl-4">
                          <Link
                            to={toolPath(system, t.name)}
                            className="font-medium font-mono text-[13px] hover:underline"
                          >
                            {t.name}
                          </Link>
                          <div className="mt-1">
                            <ToolKindBadge tool={t} />
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal pr-4 text-sm leading-6">
                          <div className="font-medium">{t.title}</div>
                          <div className="line-clamp-3 text-muted-foreground">
                            <RichText text={t.description ?? ''} />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <p className="text-muted-foreground text-xs">
              {server.data.tools.filter((t) => toolKind(t) === 'read').length} read-only,{' '}
              {server.data.tools.filter((t) => toolKind(t) !== 'read').length} write.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}
