import { URLS } from '@sim/contracts';
import type { Alert, AlertUpdate } from '@sim/contracts/logs';
import { composeLogFilter } from '@sim/contracts/logs';
import {
  Button,
  EmptyState,
  ErrorState,
  RelativeTime,
  Spinner,
  Textarea,
  UserAvatar,
} from '@sim/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronRight,
  CircleCheck,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { DetailRows, Panel } from '../chrome/Panel';
import {
  ALERT_SEVERITY_STYLE,
  AlertSeverityLabel,
  AlertStatusBadge,
  api,
  formatMoogTime,
  OPERATOR,
} from '../lib';

export function AlertDetail() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const alert = useQuery({
    queryKey: ['alert', id],
    queryFn: () => api.getAlert(id),
    refetchInterval: 5_000,
    enabled: Number.isInteger(id),
  });

  const mutation = useMutation({
    mutationFn: (body: AlertUpdate) => api.updateAlert(id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['alert', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  useEffect(() => {
    document.title = `Alert ${id} | Moogsoft`;
  }, [id]);

  if (alert.isLoading) return <Spinner label="Loading alert…" />;
  if (alert.isError || !alert.data) {
    return (
      <div>
        <Breadcrumbs id={id} />
        <div className="p-4">
          <ErrorState error={alert.error ?? new Error(`Alert ${id} not found`)} />
        </div>
      </div>
    );
  }
  const a = alert.data;
  const active = a.status === 'open' || a.status === 'acknowledged';
  const sev = ALERT_SEVERITY_STYLE[a.severity];

  const acknowledge = () =>
    mutation.mutate({
      status: 'acknowledged',
      owner: a.owner ?? OPERATOR.username,
      note: { author: OPERATOR.username, text: 'Acknowledged.' },
    });
  const resolve = () =>
    mutation.mutate({
      status: 'resolved',
      note: { author: OPERATOR.username, text: 'Resolved.' },
    });
  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    mutation.mutate(
      { note: { author: OPERATOR.username, text } },
      { onSuccess: () => setNote('') },
    );
  };

  return (
    <div className="flex min-h-full flex-col">
      <Breadcrumbs id={id} />

      {/* Alert header: severity block, summary, actions */}
      <div className="flex flex-col gap-3 border-b bg-card px-4 py-3 md:flex-row md:items-stretch">
        <div
          className="flex w-[92px] shrink-0 flex-col items-center justify-center rounded-(--radius) px-2 py-2"
          style={{ backgroundColor: sev.color, color: sev.text }}
        >
          <span className="font-bold text-[15px] leading-tight">{sev.label}</span>
          <span className="text-[10.5px] uppercase tracking-wider opacity-85">Severity</span>
        </div>
        <div className="grid min-w-0 flex-1 content-center gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span className="font-mono font-semibold text-accent-foreground">Alert {a.id}</span>
            <AlertStatusBadge status={a.status} />
            <span>
              {a.manager} · {a.class}
            </span>
            <span>
              Last event <RelativeTime value={a.last_event_time} />
            </span>
          </div>
          <h1 className="font-semibold text-[17px] text-foreground leading-snug">
            {a.description}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {a.status === 'open' && (
            <Button
              onClick={acknowledge}
              disabled={mutation.isPending}
              className="h-8 px-3 font-semibold text-[13px]"
            >
              {mutation.isPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Check data-icon="inline-start" />
              )}
              Acknowledge
            </Button>
          )}
          {active && (
            <Button
              variant="outline"
              onClick={resolve}
              disabled={mutation.isPending}
              className="h-8 bg-card px-3 font-semibold text-[13px]"
            >
              <CircleCheck data-icon="inline-start" className="text-positive" />
              Resolve
            </Button>
          )}
        </div>
      </div>

      {mutation.isError && (
        <div className="px-4 pt-3">
          <ErrorState error={mutation.error} />
        </div>
      )}

      <div className="grid items-start gap-3 p-3 lg:grid-cols-3">
        <div className="grid gap-3 lg:col-span-2">
          <Panel title="Alert Details">
            <div className="grid md:grid-cols-2 md:divide-x md:divide-border/70">
              <DetailRows
                items={[
                  { label: 'Alert ID', value: <span className="font-mono">{a.id}</span> },
                  { label: 'Severity', value: <AlertSeverityLabel severity={a.severity} /> },
                  { label: 'Status', value: <AlertStatusBadge status={a.status} /> },
                  { label: 'Service', value: a.service },
                  { label: 'Application', value: <TlaLink tla={a.app_tla} /> },
                  { label: 'Owner', value: a.owner ?? 'Unassigned' },
                ]}
              />
              <DetailRows
                items={[
                  { label: 'Source', value: <span className="font-mono">{a.source}</span> },
                  { label: 'Check', value: <span className="font-mono">{a.check}</span> },
                  { label: 'Manager', value: `${a.manager} · ${a.class}` },
                  {
                    label: 'Event count',
                    value: <span className="font-semibold tabular-nums">{a.event_count}</span>,
                  },
                  { label: 'First event', value: formatMoogTime(a.first_event_time) },
                  { label: 'Last event', value: formatMoogTime(a.last_event_time) },
                ]}
              />
            </div>
            <div className="border-t border-border/70">
              <DetailRows
                items={[
                  {
                    label: 'Incident',
                    value: a.incident_number ? (
                      <ExternalAnchor
                        href={`${URLS.servicenow.web}/incidents/${a.incident_number}`}
                      >
                        {a.incident_number}
                      </ExternalAnchor>
                    ) : (
                      'None'
                    ),
                  },
                  {
                    label: 'Dedupe key',
                    value: <span className="font-mono break-all">{a.dedupe_key}</span>,
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel
            title="Comments"
            actions={
              <span className="text-[12px] text-muted-foreground">
                {a.notes.length} comment{a.notes.length === 1 ? '' : 's'}
              </span>
            }
          >
            {a.notes.length === 0 ? (
              <EmptyState icon={<MessageSquare />} title="No comments yet" />
            ) : (
              <div className="divide-y divide-border/70">
                {a.notes.map((n, i) => (
                  <div key={i} className="flex gap-3 px-3 py-2.5">
                    <UserAvatar name={n.author} size="sm" />
                    <div className="min-w-0">
                      <div className="text-[12px] text-muted-foreground">
                        <span className="font-semibold text-foreground">{n.author}</span> ·{' '}
                        <RelativeTime value={n.at} />
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[13px]">{n.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-2 border-t bg-[#f7f9fb] p-3">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote();
                }}
                placeholder="Add a comment…"
                aria-label="Note"
                rows={2}
                className="bg-card text-[13px] md:text-[13px]"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={addNote}
                  disabled={!note.trim() || mutation.isPending}
                  className="font-semibold"
                >
                  {mutation.isPending && Boolean(note.trim()) && (
                    <Loader2 className="animate-spin" data-icon="inline-start" />
                  )}
                  Add comment
                </Button>
              </div>
            </div>
          </Panel>
        </div>

        <div className="grid gap-3">
          <Panel title="Tools" bodyClassName="grid p-1">
            <Button
              asChild
              variant="ghost"
              className="h-8 justify-start text-[13px] text-accent-foreground"
            >
              <Link to={logsLink(a)}>
                <FileText data-icon="inline-start" />
                View logs for {a.service}
              </Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="h-8 justify-start text-[13px] text-accent-foreground"
            >
              <a href={`${URLS.servicenow.web}/apps/${a.app_tla}`} target="_blank" rel="noreferrer">
                <ExternalLink data-icon="inline-start" />
                {a.app_tla} in ServiceNow CMDB
              </a>
            </Button>
          </Panel>
          <Panel title="Custom Info">
            {Object.keys(a.custom_info).length === 0 ? (
              <div className="px-3 py-2.5 text-[13px] text-muted-foreground">None</div>
            ) : (
              <DetailRows
                items={Object.entries(a.custom_info).map(([k, v]) => ({
                  label: k,
                  value: <span className="font-mono text-[12px]">{String(v)}</span>,
                }))}
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function logsLink(a: Alert) {
  const filter = composeLogFilter({ service: a.service });
  const ageH = (Date.now() - new Date(a.last_event_time).getTime()) / 3_600_000;
  const range = ageH < 0.75 ? '1h' : ageH < 5.5 ? '6h' : '24h';
  return `/logs?${new URLSearchParams({ query: filter, range })}`;
}

function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-accent-foreground hover:underline"
    >
      {children}
      <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

function TlaLink({ tla }: { tla: string }) {
  return (
    <span className="font-mono">
      <ExternalAnchor href={`${URLS.servicenow.web}/apps/${tla}`}>{tla}</ExternalAnchor>
    </span>
  );
}

function Breadcrumbs({ id }: { id: number }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex h-9 items-center gap-1.5 border-b bg-[#f7f9fb] px-4 text-[12px] text-muted-foreground"
    >
      <Link to="/alerts" className="font-semibold text-accent-foreground hover:underline">
        Alerts
      </Link>
      <ChevronRight className="size-3.5" />
      <span className="font-mono">Alert {id}</span>
    </nav>
  );
}
