import type { LogEntry, Severity } from '@sim/contracts/logs';
import { Button, cn, EmptyState, Kbd, KbdGroup, LoadMore, Spinner } from '@sim/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Eraser,
  FolderTree,
  GraduationCap,
  Link2,
  Loader2,
  type LucideIcon,
  Play,
  SearchX,
  Square,
} from 'lucide-react';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSearchParams } from 'react-router';
import { Histogram } from '../components/Histogram';
import { LogRow } from '../components/LogRow';
import { QueryEditor } from '../components/QueryEditor';
import { api, errorMessage, formatCount } from '../lib';

const RANGES = [
  { value: '5m', label: 'Last 5 minutes' },
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last 1 hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
];

const SEVERITY_OPTIONS: { value: Severity | ''; label: string }[] = [
  { value: '', label: 'All severities' },
  { value: 'DEBUG', label: 'Debug and above' },
  { value: 'INFO', label: 'Info and above' },
  { value: 'NOTICE', label: 'Notice and above' },
  { value: 'WARNING', label: 'Warning and above' },
  { value: 'ERROR', label: 'Error and above' },
  { value: 'CRITICAL', label: 'Critical and above' },
];

const PAGE_SIZE = 100;
const MAX_LIVE = 1000;
const EXAMPLE = 'severity>=ERROR\nresource.labels.container_name="payments-api"';

function rangeLabel(range: string) {
  const m = range.match(/^(\d+)([smhd])$/);
  if (!m) return range;
  const unit = { s: 'second', m: 'minute', h: 'hour', d: 'day' }[m[2] as 's' | 'm' | 'h' | 'd'];
  return `Last ${m[1]} ${unit}${m[1] === '1' ? '' : 's'}`;
}

export function LogsExplorer() {
  const [params, setParams] = useSearchParams();
  const query = params.get('query') ?? '';
  const range = params.get('range') || '1h';
  const severity = (params.get('severity') ?? '') as Severity | '';
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState(query);
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showHistogram, setShowHistogram] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = 'Logs Explorer – Logging – kb-prod – Google Cloud console';
  }, []);

  const shareLink = () => {
    void navigator.clipboard?.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Keep the editor in sync when the URL changes (back/forward, chip clicks).
  useEffect(() => setDraft(query), [query]);

  const update = useCallback(
    (next: Record<string, string>) =>
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(next)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      }),
    [setParams],
  );

  const filterArgs = useMemo(
    () => ({ filter: query || undefined, severity: severity || undefined, since: range }),
    [query, severity, range],
  );
  const key = [query, range, severity];

  const results = useInfiniteQuery({
    queryKey: ['logs', ...key],
    queryFn: ({ pageParam }) => api.search({ ...filterArgs, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const histogram = useQuery({
    queryKey: ['histogram', ...key],
    queryFn: () => api.histogram(filterArgs),
    refetchInterval: streaming ? 5_000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const run = () => {
    setLive([]);
    setExpanded(new Set());
    if (draft === query) {
      void queryClient.resetQueries({ queryKey: ['logs', ...key] });
      void histogram.refetch();
    } else {
      update({ query: draft });
    }
  };

  const addClause = useCallback(
    (clause: string) => {
      const current = query.trim();
      if (current.split('\n').some((line) => line.trim() === clause)) return;
      setLive([]);
      update({ query: current ? `${current}\n${clause}` : clause });
    },
    [query, update],
  );

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Live tail over SSE, starting right after the newest entry of the current results.
  const baseSeq = results.data?.pages[0]?.last_seq;
  useEffect(() => {
    if (!streaming || baseSeq === undefined) return;
    setLive([]);
    const source = new EventSource(api.streamUrl({ ...filterArgs, after_seq: baseSeq }));
    let buffer: LogEntry[] = [];
    source.addEventListener('log', (ev) => {
      buffer.push(JSON.parse((ev as MessageEvent<string>).data) as LogEntry);
    });
    source.addEventListener('reset', () => {
      buffer = [];
      setLive([]);
      void queryClient.resetQueries({ queryKey: ['logs'] });
    });
    const flush = setInterval(() => {
      if (buffer.length === 0) return;
      const batch = buffer.reverse();
      buffer = [];
      setLive((prev) => [...batch, ...prev].slice(0, MAX_LIVE));
    }, 300);
    return () => {
      clearInterval(flush);
      source.close();
    };
  }, [streaming, baseSeq, filterArgs, queryClient]);

  const pages = results.data?.pages;
  const entries = useMemo(() => {
    const seen = new Set<string>();
    const out: { entry: LogEntry; fresh: boolean }[] = [];
    for (const entry of live) {
      if (seen.has(entry.insertId)) continue;
      seen.add(entry.insertId);
      out.push({ entry, fresh: true });
    }
    for (const page of pages ?? []) {
      for (const entry of page.items) {
        if (seen.has(entry.insertId)) continue;
        seen.add(entry.insertId);
        out.push({ entry, fresh: false });
      }
    }
    return out;
  }, [live, pages]);

  const total = pages?.[0]?.total;
  const ranges = RANGES.some((r) => r.value === range)
    ? RANGES
    : [...RANGES, { value: range, label: rangeLabel(range) }];

  return (
    <div className="flex min-h-full flex-col">
      {/* Page title bar */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-6">
        <h1 className="font-normal text-[22px] text-foreground leading-7">Logs Explorer</h1>
        <span className="ml-3 hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] text-muted-foreground lg:inline-flex">
          <FolderTree className="size-3.5" />
          Scope: Project · kb-prod
        </span>
        <div className="ml-auto flex items-center gap-1">
          <TextButton icon={copied ? Check : Link2} onClick={shareLink}>
            {copied ? 'Link copied' : 'Share link'}
          </TextButton>
          <TextButton icon={GraduationCap}>Learn</TextButton>
        </div>
      </div>

      <div className="grid gap-3 bg-[#f8f9fa] p-4 md:px-6">
        {/* Query pane */}
        <section className="rounded-[8px] border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <GcpSelect
              icon={<Clock className="size-4" />}
              label="Time range"
              value={range}
              onChange={(v) => {
                setLive([]);
                update({ range: v });
              }}
              options={ranges}
            />
            <GcpSelect
              label="Severity"
              value={severity}
              onChange={(v) => {
                setLive([]);
                update({ severity: v });
              }}
              options={SEVERITY_OPTIONS}
            />
            <span className="ml-auto hidden text-[12px] text-muted-foreground md:inline">
              Query language: Logging query language
            </span>
          </div>
          <div className="grid gap-2 px-4 pt-3 pb-3">
            <QueryEditor
              value={draft}
              onChange={setDraft}
              onRun={run}
              placeholder={`Enter a query, e.g.\n${EXAMPLE}`}
              invalid={results.isError}
            />
            {results.isError && (
              <div className="flex items-start gap-2 text-[13px] text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{errorMessage(results.error)}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="min-w-0 flex-1 text-[12px] text-muted-foreground leading-5">
                Fields like <Code>severity</Code>, <Code>labels.app_tla</Code>,{' '}
                <Code>resource.labels.container_name</Code>, <Code>jsonPayload.message</Code> ·
                operators <Code>= != : =~ &gt;=</Code> · AND / OR / NOT
              </span>
              <TextButton
                icon={Eraser}
                disabled={!draft}
                onClick={() => setDraft('')}
                className="text-muted-foreground"
              >
                Clear query
              </TextButton>
              <span className="hidden items-center gap-1 text-[12px] text-muted-foreground sm:inline-flex">
                <KbdGroup>
                  <Kbd className="rounded-[4px] border bg-background text-[11px]">Ctrl</Kbd>+
                  <Kbd className="rounded-[4px] border bg-background text-[11px]">Enter</Kbd>
                </KbdGroup>
              </span>
              <Button
                onClick={run}
                disabled={results.isFetching && !results.isFetchingNextPage}
                className="h-9 gap-2 px-4 text-[14px] shadow-none hover:bg-[#1765cc] hover:shadow-[0_1px_2px_rgba(60,64,67,0.3),0_1px_3px_1px_rgba(60,64,67,0.15)]"
              >
                {results.isFetching && !results.isFetchingNextPage ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4 fill-current" />
                )}
                Run query
              </Button>
            </div>
          </div>
        </section>

        {/* Histogram pane */}
        <section className="rounded-[8px] border bg-card">
          <button
            type="button"
            onClick={() => setShowHistogram((v) => !v)}
            aria-expanded={showHistogram}
            className="flex h-11 w-full items-center gap-2 px-4 text-left"
          >
            <ChevronDown
              className={cn(
                'size-5 text-muted-foreground transition-transform',
                !showHistogram && '-rotate-90',
              )}
            />
            <span className="font-medium text-[14px]">Histogram</span>
          </button>
          {showHistogram && (
            <div className="px-4 pb-3">
              <Histogram data={histogram.data} loading={histogram.isLoading} />
            </div>
          )}
        </section>

        {/* Query results pane */}
        <section className="overflow-hidden rounded-[8px] border bg-card">
          <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5">
            <h2 className="font-medium text-[16px]">Query results</h2>
            {total !== undefined && (
              <span className="text-[13px] text-muted-foreground">
                {formatCount(total)} log {total === 1 ? 'entry' : 'entries'} ·{' '}
                {rangeLabel(range).toLowerCase()}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <TextButton
                icon={streaming ? Square : Play}
                aria-pressed={streaming}
                onClick={() => setStreaming((s) => !s)}
                className={cn(streaming && 'bg-accent')}
              >
                {streaming ? 'Stop stream' : 'Stream logs'}
              </TextButton>
            </div>
          </div>
          {streaming && (
            <div className="flex h-8 items-center gap-2 border-b bg-accent px-4 text-[13px] text-accent-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Streaming logs…
              {live.length > 0 && (
                <span className="text-muted-foreground">
                  {formatCount(live.length)} new {live.length === 1 ? 'entry' : 'entries'}
                </span>
              )}
            </div>
          )}
          <div className="flex h-8 items-center gap-2 border-b pr-4 pl-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            <span className="w-5" />
            <span className="w-[68px]">Severity</span>
            <span className="w-[190px]">Timestamp</span>
            <span>Summary</span>
          </div>
          {results.isLoading ? (
            <Spinner label="Running query…" />
          ) : results.isError ? (
            <EmptyState
              icon={<SearchX />}
              title="Query has errors"
              description="Fix the query above and run it again."
            />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<SearchX />}
              title="No log entries match"
              description={`Nothing in the ${rangeLabel(range).toLowerCase()}. Try a wider time range or a broader query.`}
            />
          ) : (
            <div>
              {entries.map(({ entry, fresh }) => (
                <LogRow
                  key={entry.insertId}
                  entry={entry}
                  fresh={fresh}
                  expanded={expanded.has(entry.insertId)}
                  onToggle={toggle}
                  onAddClause={addClause}
                />
              ))}
              <LoadMore
                hasMore={Boolean(results.hasNextPage)}
                loading={results.isFetchingNextPage}
                onClick={() => void results.fetchNextPage()}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[3px] bg-muted px-1 font-mono text-[12px] text-foreground">
      {children}
    </code>
  );
}

/** Material text button: blue label and icon, tinted on hover. */
function TextButton({
  icon: Icon,
  children,
  className,
  ...props
}: ComponentProps<'button'> & { icon: LucideIcon }) {
  return (
    <Button
      variant="ghost"
      className={cn(
        'h-9 gap-2 px-3 font-medium text-[14px] text-primary hover:bg-accent hover:text-primary',
        className,
      )}
      {...props}
    >
      <Icon className="size-[18px]" />
      {children}
    </Button>
  );
}

/** Outlined Material dropdown over a native <select>. */
function GcpSelect({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-flex h-9 items-center rounded-(--radius) border text-[14px] text-foreground focus-within:border-primary hover:bg-muted/60">
      {icon && <span className="pointer-events-none pl-3 text-muted-foreground">{icon}</span>}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-full cursor-pointer appearance-none bg-transparent pr-9 outline-none',
          icon ? 'pl-2' : 'pl-3',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" />
    </label>
  );
}
