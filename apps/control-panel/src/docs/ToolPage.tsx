import type { SystemName } from '@sim/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  JsonView,
  Kbd,
  Spinner,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@sim/ui';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CopyButton, InlineCode, RichText, ServiceLogo, Snippet, ToolKindBadge } from './bits';
import { EXAMPLES } from './examples';
import {
  type CallResult,
  callTool,
  exampleArgs,
  flattenParams,
  liveMcpUrl,
  type McpTool,
  type Param,
  resultValue,
  serverLabel,
  toolKind,
  useServer,
} from './mcp';
import { curlForCall, pythonForCall, tsForCall } from './snippets';

export function ToolPage({ system, name }: { system: SystemName; name: string }) {
  const server = useServer(system);
  if (server.isLoading) return <Spinner label="Loading tool" />;
  if (server.isError) return <ServerDown system={system} error={server.error} />;
  const tool = server.data?.tools.find((t) => t.name === name);
  if (!tool) {
    return (
      <EmptyState
        title={`No tool named ${name}`}
        description={`The ${serverLabel(system)} server doesn't expose it.`}
      />
    );
  }
  // Key by tool so the try-it state resets when you switch tools.
  return <ToolDetail key={`${system}/${name}`} system={system} tool={tool} />;
}

export function ServerDown({ system, error }: { system: SystemName; error: unknown }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertDescription>
        Can't reach the {serverLabel(system)} MCP server at{' '}
        <InlineCode>{liveMcpUrl(system)}</InlineCode> (
        {error instanceof Error ? error.message : String(error)}). Is{' '}
        <InlineCode>pnpm dev</InlineCode> running?
      </AlertDescription>
    </Alert>
  );
}

function ToolDetail({ system, tool }: { system: SystemName; tool: McpTool }) {
  const params = useMemo(() => flattenParams(tool.inputSchema), [tool]);
  return (
    <div className="grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-2">
        <Link
          to={`/docs/${system}`}
          className="inline-flex w-fit items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          <ServiceLogo system={system} size="xs" />
          {serverLabel(system)} server
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <ServiceLogo system={system} size="md" />
          <h1 className="font-mono font-semibold text-xl tracking-tight">{tool.name}</h1>
          <CopyButton text={tool.name} label="Copy tool name" />
          <ToolKindBadge tool={tool} />
        </div>
        {tool.title && <p className="font-medium text-sm">{tool.title}</p>}
        {tool.description && (
          <p className="max-w-3xl text-muted-foreground text-sm leading-6">
            <RichText text={tool.description} />
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          In Claude Code and the Agent SDK this tool is{' '}
          <InlineCode>
            mcp__{system}__{tool.name}
          </InlineCode>{' '}
          (or{' '}
          <InlineCode>
            mcp__sim-{system}__{tool.name}
          </InlineCode>{' '}
          with this repo's <InlineCode>.mcp.json</InlineCode>).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Parameters</CardTitle>
        </CardHeader>
        <CardContent>
          {params.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : (
            <ParamTable params={params} />
          )}
        </CardContent>
      </Card>

      <TryIt system={system} tool={tool} />
    </div>
  );
}

function ParamTable({ params }: { params: Param[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-56">Name</TableHead>
          <TableHead className="w-40">Type</TableHead>
          <TableHead>Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {params.map((p) => (
          <TableRow key={p.path} className="align-top">
            <TableCell className="whitespace-normal">
              <div
                className="flex flex-wrap items-center gap-1.5"
                style={{ paddingLeft: p.depth * 16 }}
              >
                {p.depth > 0 && <span className="text-muted-foreground">↳</span>}
                <span className="font-medium font-mono text-[13px]">{p.name}</span>
                {p.required && (
                  <StatusBadge tone="negative" className="h-4 px-1 text-[10px]">
                    required
                  </StatusBadge>
                )}
              </div>
            </TableCell>
            <TableCell className="whitespace-normal font-mono text-muted-foreground text-xs">
              {p.type}
              {p.constraints.length > 0 && (
                <div className="mt-0.5 text-[11px]">{p.constraints.join(', ')}</div>
              )}
            </TableCell>
            <TableCell className="whitespace-normal text-sm leading-6">
              {p.schema.description && <RichText text={p.schema.description} />}
              {p.enumValues && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.enumValues.map((v) => (
                    <InlineCode key={String(v)} className="text-xs">
                      {JSON.stringify(v)}
                    </InlineCode>
                  ))}
                </div>
              )}
              {p.schema.default !== undefined && (
                <div className="mt-1 text-muted-foreground text-xs">
                  Default <InlineCode>{JSON.stringify(p.schema.default)}</InlineCode>
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Outcome = { result: CallResult; ms: number };

function TryIt({ system, tool }: { system: SystemName; tool: McpTool }) {
  const curated = EXAMPLES[tool.name];
  const initial = useMemo(
    () => JSON.stringify(curated?.args ?? exampleArgs(tool.inputSchema), null, 2),
    [tool, curated],
  );
  const [text, setText] = useState(initial);
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text || '{}') as unknown };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }, [text]);
  const args = parsed.ok ? parsed.value : {};
  const url = liveMcpUrl(system);
  const call = useMutation({
    mutationFn: async (): Promise<Outcome> => {
      const started = performance.now();
      const result = await callTool(system, tool.name, args);
      return { result, ms: Math.round(performance.now() - started) };
    },
  });
  const write = toolKind(tool) !== 'read';
  const run = () => parsed.ok && !call.isPending && call.mutate();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Try it</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <p className="text-muted-foreground text-sm">
          Calls <InlineCode>{url}</InlineCode> from your browser with{' '}
          <InlineCode>tools/call</InlineCode>, exactly as an agent would.{' '}
          {curated
            ? 'The arguments are a working example against the seeded world.'
            : 'The arguments are pre-filled with the required fields.'}
        </p>
        {curated?.note && <p className="text-sm">{curated.note}</p>}
        {write && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>
              This tool changes the simulated world, acting as{' '}
              <InlineCode>svc_incident_auto</InlineCode> unless you pass an author.{' '}
              <strong>Reset</strong> in the control panel restores the baseline.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-2">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">Arguments (JSON)</span>
              <Button size="xs" variant="ghost" onClick={() => setText(initial)}>
                <RotateCcw data-icon="inline-start" />
                Example
              </Button>
            </div>
            <Textarea
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  run();
                }
              }}
              className={cn(
                'min-h-48 resize-y font-mono text-[12.5px] leading-5',
                !parsed.ok && 'border-negative focus-visible:ring-negative/30',
              )}
              aria-label="Tool arguments as JSON"
            />
            {!parsed.ok && <p className="text-negative text-xs">Invalid JSON: {parsed.error}</p>}
            <div className="flex items-center gap-3">
              <Button onClick={run} disabled={!parsed.ok || call.isPending}>
                {call.isPending ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                Call {tool.name}
              </Button>
              <span className="hidden text-muted-foreground text-xs sm:inline">
                <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
              </span>
            </div>
          </div>
          <div className="grid min-w-0 content-start gap-2">
            <span className="font-medium text-sm">Response</span>
            <ResultView outcome={call.data} error={call.error} pending={call.isPending} />
          </div>
        </div>
        <div className="grid gap-2">
          <span className="font-medium text-sm">This call as code</span>
          <Tabs defaultValue="curl">
            <TabsList variant="line">
              <TabsTrigger value="curl">curl</TabsTrigger>
              <TabsTrigger value="ts">TypeScript</TabsTrigger>
              <TabsTrigger value="py">Python</TabsTrigger>
            </TabsList>
            <TabsContent value="curl">
              <Snippet code={curlForCall(url, tool.name, args)} language="bash" />
            </TabsContent>
            <TabsContent value="ts">
              <Snippet code={tsForCall(system, url, tool.name, args)} language="typescript" />
            </TabsContent>
            <TabsContent value="py">
              <Snippet code={pythonForCall(url, tool.name, args)} language="python" />
            </TabsContent>
          </Tabs>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultView({
  outcome,
  error,
  pending,
}: {
  outcome: Outcome | undefined;
  error: Error | null;
  pending: boolean;
}) {
  if (pending) {
    return (
      <div className="grid min-h-48 place-items-center border bg-muted/30">
        <Spinner label="Calling" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-48 border border-negative/40 bg-negative/5 p-3 text-negative text-sm">
        {error.message}
      </div>
    );
  }
  if (!outcome) {
    return (
      <div className="grid min-h-48 place-items-center border border-dashed text-muted-foreground text-sm">
        Run the call to see the response.
      </div>
    );
  }
  const { json, text } = resultValue(outcome.result);
  const isError = outcome.result.isError;
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center gap-2 text-xs">
        <StatusBadge tone={isError ? 'negative' : 'positive'} dot>
          {isError ? 'isError' : 'ok'}
        </StatusBadge>
        <span className="text-muted-foreground tabular-nums">{outcome.ms} ms</span>
        <span className="text-muted-foreground tabular-nums">
          {(text.length / 1024).toFixed(1)} KB
        </span>
        <CopyButton
          text={json === undefined ? text : JSON.stringify(json, null, 2)}
          className="ml-auto"
        />
      </div>
      <div className="max-h-[32rem] overflow-auto border bg-muted/30 p-3">
        {json === undefined ? (
          <pre className="whitespace-pre-wrap font-mono text-xs">{text}</pre>
        ) : (
          <JsonView value={json} />
        )}
      </div>
      {isError && (
        <p className="text-muted-foreground text-xs">
          Tool errors come back as a readable message with <InlineCode>isError: true</InlineCode>,
          so the model can correct its arguments and retry.
        </p>
      )}
    </div>
  );
}
