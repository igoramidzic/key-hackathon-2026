import {
  COMMUNICATION_KIND_LABELS,
  type Communication,
  type CommunicationKind,
  type CommunicationState,
  type Priority,
} from '@sim/contracts/servicenow';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  formatDateTime,
  RelativeTime,
  Spinner,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@sim/ui';
import { Loader2, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useCommunication, useCommunications, useSendCommunication } from '../api';
import { Muted, refLinkClass } from '../components/bits';
import { FormHeader } from '../components/form';
import { Page, usePageTitle } from '../components/Layout';
import { ListFrame, listHeaderRowClass, listRowClass, SortHead } from '../components/list';
import { formatEasternTime, formatEmailDuration } from '../format';

/** NEW / UPDATE / RESTORED: the kind of email, as its subject line names it. */
export function CommunicationKindBadge({ kind }: { kind: CommunicationKind }) {
  return (
    <StatusBadge tone="neutral" className="font-semibold tracking-wide">
      {COMMUNICATION_KIND_LABELS[kind]}
    </StatusBadge>
  );
}

export function CommunicationStateBadge({ state }: { state: CommunicationState }) {
  return (
    <StatusBadge tone={state === 'sent' ? 'positive' : 'warning'} dot>
      {state === 'sent' ? 'Sent' : 'Draft'}
    </StatusBadge>
  );
}

const when = (iso: string | null) =>
  iso ? (
    <span title={formatDateTime(iso)}>
      <RelativeTime value={iso} />
    </span>
  ) : (
    <Muted>—</Muted>
  );

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const PAGE = 50;

export function CommunicationList() {
  const [limit, setLimit] = useState(PAGE);
  const { data, error, isLoading } = useCommunications({ limit });
  const navigate = useNavigate();
  usePageTitle('Critical Incident Communications');
  const items = data?.items ?? [];

  return (
    <Page>
      <ListFrame
        title="Critical Incident Communications"
        count={data ? { shown: items.length, total: data.total ?? items.length } : undefined}
        hasMore={!!data?.next_cursor}
        onMore={() => setLimit((n) => n + PAGE)}
      >
        {error ? (
          <div className="p-3">
            <ErrorState error={error} />
          </div>
        ) : isLoading || !data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No communications" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead className="w-32">Number</SortHead>
                <SortHead>Subject</SortHead>
                <SortHead className="w-44">To</SortHead>
                <SortHead className="w-28">Kind</SortHead>
                <SortHead className="w-24">State</SortHead>
                <SortHead className="w-28">Drafted</SortHead>
                <SortHead className="w-28">Sent</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow
                  key={c.number}
                  data-demo="communication-row"
                  data-number={c.number}
                  onClick={() => navigate(`/communications/${c.number}`)}
                  className={cn(listRowClass, 'cursor-pointer')}
                >
                  <TableCell>
                    <Link
                      to={`/communications/${c.number}`}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(refLinkClass, 'font-medium')}
                    >
                      {c.number}
                    </Link>
                  </TableCell>
                  <TableCell className="w-full max-w-0 min-w-48">
                    <div className="truncate" title={c.subject}>
                      {c.subject}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{c.to}</TableCell>
                  <TableCell>
                    <CommunicationKindBadge kind={c.kind} />
                  </TableCell>
                  <TableCell>
                    <CommunicationStateBadge state={c.state} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{when(c.drafted_at)}</TableCell>
                  <TableCell className="text-muted-foreground">{when(c.sent_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListFrame>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Detail: the email as its recipients see it
// ---------------------------------------------------------------------------

/** The email's priority bar: P1 red, P2 orange, P3 green, P4 and P5 gray. */
const PRIORITY_BAR: Record<Priority, string> = {
  1: 'bg-negative',
  2: 'bg-warning',
  3: 'bg-positive',
  4: 'bg-muted-foreground',
  5: 'bg-muted-foreground',
};

function EmailBody({ communication: c }: { communication: Communication }) {
  const rows: [string, ReactNode][] = [['Start', formatEasternTime(c.start)]];
  if (c.resolved) {
    rows.push(['Resolved', formatEasternTime(c.resolved)]);
    if (c.duration_minutes !== null)
      rows.push(['Duration', formatEmailDuration(c.duration_minutes)]);
  }
  rows.push(['Systems Impacted', c.systems_impacted.map((app) => app.tla).join(', ') || '—']);
  rows.push(['Description', c.description]);
  if (c.client_impact) rows.push(['Impact to our Clients', c.client_impact]);
  if (c.employee_impact) rows.push(['Impact to our Employees', c.employee_impact]);
  if (c.cause) rows.push(['Cause', c.cause]);
  if (c.resolution_activities) rows.push(['Resolution Activities', c.resolution_activities]);

  const people: [string, string][] = [
    ['Incident Manager', c.incident_manager?.name ?? '—'],
    ['Communication Specialist', c.communication_specialist?.name ?? '—'],
    ['Technology Owners', c.technology_owners.map((u) => u.name).join(', ') || '—'],
  ];

  return (
    <div className="max-w-[760px] text-[14px]/relaxed text-foreground">
      <div data-demo="communication-email" className="border bg-card">
        <div className="px-3 py-2.5 font-bold text-[16px]">Critical Incident Communication</div>
        <div className={cn('px-3 py-1.5 font-bold text-white', PRIORITY_BAR[c.priority])}>
          Priority {c.priority}
        </div>
        {rows.map(([label, value]) => (
          <div
            key={label}
            data-demo={`communication-item:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            className="whitespace-pre-wrap border-t px-3 py-2 odd:bg-list-stripe even:bg-card"
          >
            <span className="font-bold">{label}:</span> {value}
          </div>
        ))}
      </div>
      <div className="mt-5 space-y-0.5">
        {people.map(([label, value]) => (
          <div key={label}>
            <span className="font-bold">{label}:</span> {value}
          </div>
        ))}
      </div>
      <p className="mt-5">
        Questions about this Incident? Contact the Critical Incident Communications team at
        216-555-0188 or reply to this email.
      </p>
      <p className="mt-3 text-[12px] text-destructive">
        KeyBank Internal Only: Do not forward externally.
      </p>
    </div>
  );
}

export function CommunicationDetail() {
  const { number = '' } = useParams();
  const { data: communication, error, isLoading } = useCommunication(number);
  const send = useSendCommunication(number);
  usePageTitle(`Communication - ${number}`);

  if (isLoading) return <Spinner label="Loading communication" />;
  if (error || !communication) {
    return (
      <Page>
        <ErrorState error={error ?? `Communication ${number} not found`} />
      </Page>
    );
  }
  const c = communication;
  const draft = c.state === 'draft';

  return (
    <div>
      <FormHeader
        backTo="/communications"
        backLabel="Back to communications"
        recordType="Critical Incident Communication"
        title={`${c.number} · ${COMMUNICATION_KIND_LABELS[c.kind]} · ${c.incident}`}
        actions={
          <>
            {send.error && (
              <span className="max-w-xs text-destructive text-xs">{send.error.message}</span>
            )}
            <Button asChild size="sm" variant="outline">
              <Link to={`/incidents/${c.incident}`}>Incident {c.incident}</Link>
            </Button>
            {draft ? (
              <Button
                size="sm"
                data-demo="send-communication"
                disabled={send.isPending}
                onClick={() => send.mutate()}
              >
                {send.isPending ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Send data-icon="inline-start" />
                )}
                Send to {c.to}
              </Button>
            ) : (
              <CommunicationStateBadge state="sent" />
            )}
          </>
        }
      />

      <Page>
        <article className="rounded-(--radius) border bg-card">
          <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 border-b px-5 py-4">
            <div className="min-w-0">
              <h1
                data-demo="communication-subject"
                className="w-fit font-bold text-[18px] text-foreground leading-snug"
              >
                {c.subject}
              </h1>
              <div className="mt-2.5 grid gap-1 text-[13px]">
                <div className="flex gap-3">
                  <span className="w-10 shrink-0 text-muted-foreground">From</span>
                  <span className="min-w-0 break-words text-foreground">{c.from}</span>
                </div>
                <div data-demo="communication-to" className="flex w-fit gap-3">
                  <span className="w-10 shrink-0 text-muted-foreground">To</span>
                  <span className="font-semibold text-foreground">{c.to}</span>
                </div>
              </div>
            </div>
            <div className="text-[13px] text-muted-foreground sm:text-right">
              {draft ? (
                <>
                  <StatusBadge tone="warning" dot>
                    Draft · not sent
                  </StatusBadge>
                  <div className="mt-1.5">
                    Drafted by {c.drafted_by.name} ·{' '}
                    <span title={formatDateTime(c.drafted_at)}>
                      <RelativeTime value={c.drafted_at} />
                    </span>
                  </div>
                </>
              ) : (
                <span className="text-foreground">
                  Sent {c.sent_at ? formatDateTime(c.sent_at) : ''}
                  {c.sent_by ? ` by ${c.sent_by.name}` : ''}
                </span>
              )}
            </div>
          </header>
          <div className="px-5 py-5">
            <EmailBody communication={c} />
          </div>
        </article>
      </Page>
    </div>
  );
}
