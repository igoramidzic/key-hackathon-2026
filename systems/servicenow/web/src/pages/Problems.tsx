import {
  PROBLEM_STATE_LABELS,
  PROBLEM_STATES,
  type Problem,
  type ProblemListQuery,
  type ProblemState,
  STANDUP,
} from '@sim/contracts/servicenow';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  NativeSelect,
  RelativeTime,
  Spinner,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  type Tone,
  useDebounced,
} from '@sim/ui';
import { CalendarClock, Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useProblem, useProblemStandup, useProblems, useUpdateProblem } from '../api';
import { Journal } from '../components/Activity';
import {
  GroupLink,
  Muted,
  PriorityBadge,
  RecordLink,
  refLinkClass,
  Section,
  TlaChip,
  UserLink,
} from '../components/bits';
import {
  FormBody,
  FormColumn,
  FormColumns,
  FormField,
  FormHeader,
  fieldInputClass,
} from '../components/form';
import { IncidentTable } from '../components/IncidentTable';
import { Page, usePageTitle } from '../components/Layout';
import {
  type Crumb,
  ListFrame,
  ListSearch,
  listHeaderRowClass,
  listRowClass,
  SortHead,
} from '../components/list';
import { formatStandupDate } from '../format';

const STATE_TONES: Record<ProblemState, Tone> = {
  open: 'info',
  root_cause_analysis: 'warning',
  fix_in_progress: 'positive',
  resolved: 'neutral',
  closed: 'neutral',
};

export function ProblemStateBadge({ state }: { state: ProblemState }) {
  const done = state === 'resolved' || state === 'closed';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        done && 'text-muted-foreground',
      )}
    >
      <StatusDot tone={STATE_TONES[state]} className="size-1.5 rounded-full" />
      {PROBLEM_STATE_LABELS[state]}
    </span>
  );
}

const dash = (value: ReactNode) => value || <Muted>—</Muted>;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type View = 'active' | 'all';

const VIEWS: { value: View; label: string; query: ProblemListQuery }[] = [
  { value: 'active', label: 'Active', query: { active: true } },
  { value: 'all', label: 'All', query: {} },
];

const PAGE = 50;

export function ProblemList() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find((v) => v.value === params.get('view')) ?? VIEWS[0]!;
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q.trim(), 250);
  const [limit, setLimit] = useState(PAGE);
  const { data, error, isLoading } = useProblems({
    ...view.query,
    q: debouncedQ || undefined,
    limit,
  });
  const navigate = useNavigate();
  usePageTitle(view.value === 'all' ? 'Problems - All' : 'Problems');
  const items = data?.items ?? [];

  const setView = (value: string) => {
    setParams(value === 'active' ? {} : { view: value }, { replace: true });
    setLimit(PAGE);
  };
  const crumbs: Crumb[] = [
    { label: 'All', onClick: () => setView('all') },
    ...(view.value === 'active' ? [{ label: 'Active = true' }] : []),
  ];

  return (
    <Page>
      <ListFrame
        title="Problems"
        search={
          <ListSearch
            value={q}
            onChange={(v) => {
              setQ(v);
              setLimit(PAGE);
            }}
            placeholder="Search number, description, app…"
            label="Search problems"
          />
        }
        crumbs={crumbs}
        count={data ? { shown: items.length, total: data.total ?? items.length } : undefined}
        hasMore={!!data?.next_cursor}
        onMore={() => setLimit((n) => n + PAGE)}
        toolbar={
          <>
            <Tabs value={view.value} onValueChange={setView}>
              <TabsList variant="line" className="h-7 gap-0">
                {VIEWS.map((v) => (
                  <TabsTrigger
                    key={v.value}
                    value={v.value}
                    className="px-3 text-[13px] data-active:text-foreground group-data-horizontal/tabs:after:bottom-[-4px] after:bg-primary"
                  >
                    {v.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button asChild size="sm" variant="outline" className="ml-auto">
              <Link to="/problems/standup">
                <CalendarClock data-icon="inline-start" />
                Stand-up agenda
              </Link>
            </Button>
          </>
        }
      >
        {error ? (
          <div className="p-3">
            <ErrorState error={error} />
          </div>
        ) : isLoading || !data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No problems match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead className="w-32">Number</SortHead>
                <SortHead>Short description</SortHead>
                <SortHead className="w-44">State</SortHead>
                <SortHead className="w-32">Priority</SortHead>
                <SortHead className="w-24">CI</SortHead>
                <SortHead className="w-40">Cause code</SortHead>
                <SortHead className="w-24">Incidents</SortHead>
                <SortHead className="w-32">Stand-up</SortHead>
                <SortHead className="w-28">Opened</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow
                  key={p.number}
                  data-demo="problem-row"
                  data-number={p.number}
                  onClick={() => navigate(`/problems/${p.number}`)}
                  className={cn(listRowClass, 'cursor-pointer')}
                >
                  <TableCell>
                    <Link
                      to={`/problems/${p.number}`}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(refLinkClass, 'font-medium')}
                    >
                      {p.number}
                    </Link>
                  </TableCell>
                  <TableCell className="w-full max-w-0 min-w-48">
                    <div className="truncate" title={p.short_description}>
                      {p.short_description}
                    </div>
                  </TableCell>
                  <TableCell>
                    <ProblemStateBadge state={p.state} />
                  </TableCell>
                  <TableCell>
                    <PriorityBadge priority={p.priority} />
                  </TableCell>
                  <TableCell>{p.app ? <TlaChip app={p.app} /> : null}</TableCell>
                  <TableCell className="whitespace-nowrap">{p.cause_code}</TableCell>
                  <TableCell className="tabular-nums" title={p.incidents.join(', ')}>
                    {p.incidents.length}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {p.standup_date ? formatStandupDate(p.standup_date, 'short') : <Muted>—</Muted>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime value={p.opened_at} />
                  </TableCell>
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
// Stand-up agenda
// ---------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function AgendaItem({ problem: p }: { problem: Problem }) {
  const paragraphs: [string, string | null][] = [
    ['Impact to clients', p.client_impact],
    ['Impact to employees', p.employee_impact],
    ['Root cause', p.root_cause],
    ['Mitigation/Repair plan', p.mitigation_plan],
    ['Action items', p.action_items],
  ];
  return (
    <li
      data-demo="standup-item"
      data-number={p.number}
      className="rounded-(--radius) border bg-card"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <Link
          to={`/problems/${p.number}`}
          className={cn(refLinkClass, 'font-semibold text-[14px]')}
        >
          {p.number}
        </Link>
        <h2 className="min-w-0 flex-1 font-semibold text-[15px] text-foreground">
          {p.short_description}
        </h2>
        <span className="flex items-center gap-4 text-[13px]">
          <PriorityBadge priority={p.priority} />
          <ProblemStateBadge state={p.state} />
        </span>
      </header>
      <dl className="flex flex-wrap items-center gap-x-8 gap-y-1.5 border-b bg-list-stripe px-4 py-2 text-[13px]">
        <Fact label="Configuration item">
          {p.app ? <TlaChip app={p.app} showName /> : <Muted>—</Muted>}
        </Fact>
        <Fact label="Incidents">
          {p.incidents.length > 0 ? (
            <span className="flex flex-wrap gap-x-2">
              {p.incidents.map((n) => (
                <RecordLink key={n} table="incidents" number={n} />
              ))}
            </span>
          ) : (
            <Muted>—</Muted>
          )}
        </Fact>
        <Fact label="Coordinator">
          <UserLink user={p.problem_coordinator} />
        </Fact>
        <Fact label="Assignment group">
          <GroupLink group={p.assignment_group} />
        </Fact>
      </dl>
      <dl className="grid gap-x-4 gap-y-1 px-4 py-3 text-[13px]/relaxed sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-y-2.5">
        {paragraphs.map(([label, text]) => (
          <div key={label} className="contents">
            <dt className="font-semibold text-foreground sm:text-right sm:font-normal sm:text-muted-foreground">
              {label}
            </dt>
            <dd className="max-w-[90ch] whitespace-pre-wrap text-foreground">{dash(text)}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

export function ProblemStandupPage() {
  const [params] = useSearchParams();
  const date = params.get('date') || 'next';
  const { data, error, isLoading } = useProblemStandup(date);
  usePageTitle('Problem stand-up');
  const problems = data?.problems ?? [];

  return (
    <div>
      <FormHeader
        backTo="/problems"
        backLabel="Back to problems"
        recordType="Problem stand-up"
        title={data ? `${formatStandupDate(data.date)} · ${STANDUP.label}` : STANDUP.label}
        actions={
          data && problems.length > 0 ? (
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {problems.length} {problems.length === 1 ? 'problem' : 'problems'} on the agenda
            </span>
          ) : undefined
        }
      />
      <Page>
        {error ? (
          <ErrorState error={error} />
        ) : isLoading || !data ? (
          <Spinner label="Loading agenda" />
        ) : problems.length === 0 ? (
          <div className="rounded-(--radius) border bg-card">
            <EmptyState title="Nothing on the agenda." />
          </div>
        ) : (
          <ol data-demo="standup-agenda" className="space-y-4">
            {problems.map((p) => (
              <AgendaItem key={p.number} problem={p} />
            ))}
          </ol>
        )}
      </Page>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/** The State field: a choice list that saves on change. */
function StateField({ problem }: { problem: Problem }) {
  const update = useUpdateProblem(problem.number);
  return (
    <FormField label="State" htmlFor="problem-state" editable>
      <div className="flex items-center gap-2">
        <NativeSelect
          id="problem-state"
          value={problem.state}
          onChange={(e) => update.mutate({ state: e.target.value as ProblemState })}
          className={`${fieldInputClass} w-full`}
        >
          {PROBLEM_STATES.map((s) => (
            <option key={s} value={s}>
              {PROBLEM_STATE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        {update.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {update.error && <div className="mt-1 text-destructive text-xs">{update.error.message}</div>}
    </FormField>
  );
}

function Notes({ problem }: { problem: Problem }) {
  const update = useUpdateProblem(problem.number);
  const posting = update.isPending && update.variables?.work_note !== undefined;
  return (
    <Journal
      journal={problem.journal}
      comments={false}
      poster={{
        post: (note, done) => update.mutate({ work_note: note.text }, { onSuccess: done }),
        pending: posting,
        error: update.error,
      }}
    />
  );
}

export function ProblemDetail() {
  const { number = '' } = useParams();
  const { data: problem, error, isLoading } = useProblem(number);
  usePageTitle(`Problem - ${number}`);

  if (isLoading) return <Spinner label="Loading problem" />;
  if (error || !problem) {
    return (
      <Page>
        <ErrorState error={error ?? `Problem ${number} not found`} />
      </Page>
    );
  }
  const p = problem;
  const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

  return (
    <div>
      <FormHeader
        backTo="/problems"
        backLabel="Back to problems"
        recordType="Problem"
        title={
          <span title={p.short_description}>
            {p.number} · {p.short_description}
          </span>
        }
        actions={
          <span className="text-[13px]">
            <ProblemStateBadge state={p.state} />
          </span>
        }
      />

      <Page>
        <FormBody className="grid gap-2.5">
          <FormColumns>
            <FormColumn>
              <FormField label="Number">{p.number}</FormField>
              <FormField label="Configuration item" href={p.app ? `/apps/${p.app.tla}` : undefined}>
                {p.app ? <TlaChip app={p.app} showName className="h-5" /> : <Muted>—</Muted>}
              </FormField>
              <FormField label="Incident priority">
                {p.incident_priority ? (
                  <PriorityBadge priority={p.incident_priority} />
                ) : (
                  <Muted>—</Muted>
                )}
              </FormField>
              <FormField label="Priority">
                <PriorityBadge priority={p.priority} />
              </FormField>
              <FormField label="Cause code">{p.cause_code}</FormField>
              <FormField label="Chronic problem">{yesNo(p.chronic)}</FormField>
              <FormField label="Proactive">{yesNo(p.proactive)}</FormField>
            </FormColumn>
            <FormColumn>
              <StateField problem={p} />
              <FormField
                label="Assignment group"
                href={p.assignment_group ? `/groups/${p.assignment_group.id}` : undefined}
              >
                <GroupLink group={p.assignment_group} />
              </FormField>
              <FormField
                label="Assigned to"
                href={p.assigned_to?.web_url ? `/users/${p.assigned_to.username}` : undefined}
              >
                <UserLink user={p.assigned_to} />
              </FormField>
              <FormField
                label="Problem coordinator"
                href={
                  p.problem_coordinator?.web_url
                    ? `/users/${p.problem_coordinator.username}`
                    : undefined
                }
              >
                <UserLink user={p.problem_coordinator} />
              </FormField>
              <FormField
                label="Stand-up"
                demo="standup"
                href={p.standup_date ? `/problems/standup?date=${p.standup_date}` : undefined}
              >
                {p.standup_date ? (
                  `${formatStandupDate(p.standup_date)} · ${STANDUP.label}`
                ) : (
                  <Muted>Not on the agenda</Muted>
                )}
              </FormField>
            </FormColumn>
          </FormColumns>
          <div className="mt-2 grid gap-2.5">
            <FormField label="Short description" multiline>
              {p.short_description}
            </FormField>
            <FormField label="Description" multiline className="min-h-16">
              {p.description || <Muted>No description</Muted>}
            </FormField>
            <FormField label="Root cause" multiline>
              {dash(p.root_cause)}
            </FormField>
            <FormField label="Workaround" multiline>
              {dash(p.workaround)}
            </FormField>
            <FormField label="Mitigation/Repair Plan" demo="mitigation-plan" multiline>
              {dash(p.mitigation_plan)}
            </FormField>
            <FormField label="Action items" multiline>
              {dash(p.action_items)}
            </FormField>
            <FormField label="Impact to clients" demo="client-impact" multiline>
              {dash(p.client_impact)}
            </FormField>
            <FormField label="Impact to employees" demo="employee-impact" multiline>
              {dash(p.employee_impact)}
            </FormField>
          </div>
        </FormBody>

        <Section title="Related Records">
          <FormColumns>
            <FormColumn>
              <FormField
                label="Change request"
                href={p.change_request ? `/change_requests/${p.change_request}` : undefined}
              >
                <RecordLink table="change_requests" number={p.change_request} />
              </FormField>
              <FormField
                label="Caused by change"
                href={p.caused_by_change ? `/change_requests/${p.caused_by_change}` : undefined}
              >
                <RecordLink table="change_requests" number={p.caused_by_change} />
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="Vendor">{dash(p.vendor)}</FormField>
            </FormColumn>
          </FormColumns>
        </Section>

        <Section
          title={`Investigates incidents (${p.related_incidents.length})`}
          bodyClassName="p-0"
        >
          <IncidentTable items={p.related_incidents} empty="No incidents linked" />
        </Section>

        <Notes problem={p} />
      </Page>
    </div>
  );
}
