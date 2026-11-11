import type { Alert, AlertSeverity } from '@sim/contracts/logs';
import {
  cn,
  EmptyState,
  ErrorState,
  formatRelative,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  useDebounced,
} from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { BellOff, Filter, RefreshCw } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  ALERT_SEVERITY_ORDER,
  ALERT_SEVERITY_STYLE,
  AlertSeverityLabel,
  AlertStatusBadge,
  api,
  formatMoogTime,
} from '../lib';

const FILTERS = [
  { value: 'active', label: 'Active', status: 'open,acknowledged' },
  { value: 'open', label: 'Open', status: 'open' },
  { value: 'acknowledged', label: 'Acknowledged', status: 'acknowledged' },
  { value: 'resolved', label: 'Resolved', status: 'resolved' },
  { value: 'closed', label: 'Closed', status: 'closed' },
  { value: 'all', label: 'All', status: '' },
] as const;
type FilterValue = (typeof FILTERS)[number]['value'];

export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const filter = (FILTERS.find((f) => f.value === params.get('status'))?.value ??
    'active') as FilterValue;
  const search = params.get('q') ?? '';
  const q = useDebounced(search, 250);
  const status = FILTERS.find((f) => f.value === filter)!.status;

  useEffect(() => {
    document.title = 'Alerts | Moogsoft';
  }, []);

  const alerts = useQuery({
    queryKey: ['alerts', status, q],
    queryFn: () => api.listAlerts({ status: status || undefined, q: q || undefined, limit: 200 }),
    refetchInterval: 5_000,
  });

  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true },
    );

  const items = alerts.data?.items;
  const bySeverity = useMemo(() => {
    const counts: Record<AlertSeverity, number> = {
      critical: 0,
      major: 0,
      minor: 0,
      warning: 0,
      clear: 0,
    };
    for (const a of items ?? []) counts[a.severity]++;
    return counts;
  }, [items]);

  return (
    <div className="flex min-h-full flex-col">
      {/* Title strip with the severity summary */}
      <div className="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 border-b bg-card px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h1 className="font-semibold text-[17px] text-foreground">Alerts</h1>
          <span className="text-[12px] text-muted-foreground">
            {FILTERS.find((f) => f.value === filter)!.label} alerts
          </span>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Alerts by severity">
          {ALERT_SEVERITY_ORDER.map((sev) => {
            const style = ALERT_SEVERITY_STYLE[sev];
            return (
              <span
                key={sev}
                title={`${style.label}: ${bySeverity[sev]}`}
                className={cn(
                  'inline-flex h-7 min-w-[64px] items-center justify-between gap-2 rounded-(--radius) px-2 font-semibold text-[12px]',
                  bySeverity[sev] === 0 && 'opacity-35',
                )}
                style={{ backgroundColor: style.color, color: style.text }}
              >
                <span className="font-normal opacity-90">{style.label}</span>
                <span className="tabular-nums">{bySeverity[sev]}</span>
              </span>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <RefreshCw className={cn('size-3.5', alerts.isFetching && 'animate-spin')} />
          Auto-refresh 5s
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-2 border-b bg-[#f7f9fb] px-4 py-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-80">
          <Filter className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => set('q', e.target.value)}
            placeholder="Filter alerts by description, source, service…"
            aria-label="Search alerts"
            className="h-8 bg-card pl-8 text-[13px] md:text-[13px]"
          />
        </div>
        <Tabs value={filter} onValueChange={(v) => set('status', v === 'active' ? '' : v)}>
          <TabsList className="h-8 gap-0 rounded-(--radius) border bg-card p-0">
            {FILTERS.map((f) => (
              <TabsTrigger
                key={f.value}
                value={f.value}
                className="h-full rounded-none border-0 border-r px-3 font-semibold text-[12px] text-muted-foreground last:border-r-0 data-active:bg-primary data-active:text-primary-foreground"
              >
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {alerts.data && (
          <span className="text-[12px] text-muted-foreground sm:ml-auto">
            Showing {alerts.data.items.length} of {alerts.data.total} alert
            {alerts.data.total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="p-3">
        <div className="overflow-hidden rounded-(--radius) border bg-card shadow-[0_1px_2px_rgba(16,36,60,0.06)]">
          {alerts.isLoading ? (
            <Spinner label="Loading alerts…" />
          ) : alerts.isError ? (
            <div className="p-4">
              <ErrorState error={alerts.error} />
            </div>
          ) : alerts.data!.items.length === 0 ? (
            <EmptyState
              icon={<BellOff />}
              title="No alerts"
              description={
                filter === 'active' ? 'Nothing is firing right now.' : 'No alerts match.'
              }
            />
          ) : (
            <Table className="text-[12.5px] [&_td]:border-r [&_td]:border-border/60 [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-border/80 [&_th:last-child]:border-r-0">
              <TableHeader>
                <TableRow className="border-b-2 bg-[#e9edf2] hover:bg-[#e9edf2]">
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Alert ID</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Severity</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Status</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Description</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Source</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Service</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Manager</TableHead>
                  <TableHead className="h-8 px-2 text-right font-bold text-[12px]">Count</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">First Event</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Last Event</TableHead>
                  <TableHead className="h-8 px-2 font-bold text-[12px]">Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.data!.items.map((a) => (
                  <AlertRow key={a.id} alert={a} onOpen={() => navigate(`/alerts/${a.id}`)} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}

function AlertRow({ alert: a, onOpen }: { alert: Alert; onOpen: () => void }) {
  const muted = a.status === 'resolved' || a.status === 'closed';
  return (
    <TableRow
      data-demo="alert-row"
      data-id={a.id}
      data-status={a.status}
      onClick={onOpen}
      className={cn(
        'h-[34px] cursor-pointer border-border/70 even:bg-[#f7f9fb] hover:bg-accent',
        muted && 'text-muted-foreground',
      )}
    >
      <TableCell className="px-2 py-0 font-mono text-[12px] text-accent-foreground">
        {a.id}
      </TableCell>
      <TableCell className="w-[88px] p-[3px]">
        <AlertSeverityLabel
          severity={a.severity}
          block
          className={cn('h-7', muted && 'opacity-60')}
        />
      </TableCell>
      <TableCell className="px-2 py-0">
        <AlertStatusBadge status={a.status} />
      </TableCell>
      <TableCell className="w-full max-w-0 min-w-56 px-2 py-1">
        <div
          className={cn('truncate', !muted && 'font-semibold text-foreground')}
          title={a.description}
        >
          {a.description}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground">
          {a.class} · {a.check}
        </div>
      </TableCell>
      <TableCell className="px-2 py-0">
        <div className="max-w-[150px] truncate font-mono text-[11.5px]" title={a.source}>
          {a.source}
        </div>
      </TableCell>
      <TableCell className="px-2 py-0">
        <div className="flex max-w-[180px] items-center gap-1.5">
          <span className="rounded-(--radius) bg-[#dfe5ec] px-1.5 py-px font-mono font-semibold text-[10.5px] text-foreground">
            {a.app_tla}
          </span>
          <span className="truncate">{a.service}</span>
        </div>
      </TableCell>
      <TableCell className="px-2 py-0">{a.manager}</TableCell>
      <TableCell className="px-2 py-0 text-right font-semibold tabular-nums">
        {a.event_count}
      </TableCell>
      <TableCell
        className="px-2 py-0 tabular-nums"
        title={`${formatMoogTime(a.first_event_time)} (${formatRelative(a.first_event_time)})`}
      >
        {formatMoogTime(a.first_event_time, true)}
      </TableCell>
      <TableCell
        className={cn('px-2 py-0 tabular-nums', !muted && 'text-foreground')}
        title={`${formatMoogTime(a.last_event_time)} (${formatRelative(a.last_event_time)})`}
      >
        {formatMoogTime(a.last_event_time, true)}
      </TableCell>
      <TableCell className="px-2 py-0">
        {a.owner ?? <span className="text-muted-foreground/70">Unassigned</span>}
      </TableCell>
    </TableRow>
  );
}
