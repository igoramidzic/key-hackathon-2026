import {
  CHANGE_CLOSE_CODE_LABELS,
  CHANGE_RISK_LABELS,
  CHANGE_STATE_LABELS,
  CHANGE_TYPE_LABELS,
  CHANGE_TYPES,
  type ChangeListQuery,
  type ChangeRequest,
  type ChangeState,
  type ChangeType,
  RELEASE_STATUS_LABELS,
} from '@sim/contracts/servicenow';
import {
  Button,
  cn,
  EmptyState,
  Input,
  NativeSelect,
  RelativeTime,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Textarea,
  type Tone,
  useDebounced,
} from '@sim/ui';
import { ExternalLink, Loader2, Rocket } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  CURRENT_USER,
  useApp,
  useChange,
  useChanges,
  useCreateChange,
  useUpdateChange,
} from '../api';
import { GroupLink, Muted, refLinkClass, Section, TlaChip, UserLink } from '../components/bits';
import {
  FormBody,
  FormColumn,
  FormColumns,
  FormField,
  FormHeader,
  fieldInputClass,
} from '../components/form';
import { Page, usePageTitle } from '../components/Layout';
import { ListFrame, listHeaderRowClass, listRowClass, SortHead } from '../components/list';

const STATE_TONES: Record<ChangeState, Tone> = {
  new: 'info',
  scheduled: 'warning',
  implement: 'positive',
  closed: 'neutral',
  canceled: 'neutral',
};

export function ChangeStateBadge({ state }: { state: ChangeState }) {
  const done = state === 'closed' || state === 'canceled';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        done && 'text-muted-foreground',
      )}
    >
      <StatusDot tone={STATE_TONES[state]} className="size-1.5 rounded-full" />
      {CHANGE_STATE_LABELS[state]}
    </span>
  );
}

const when = (iso: string | null) =>
  iso ? (
    <span title={new Date(iso).toLocaleString()}>
      <RelativeTime value={iso} />
    </span>
  ) : (
    <Muted>—</Muted>
  );

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const VIEWS: Record<string, { label: string; query: ChangeListQuery }> = {
  active: {
    label: 'Open',
    query: { active: true, sort: 'planned_start' },
  },
  implemented: {
    label: 'Implemented',
    query: { state: ['closed'], sort: '-implemented_at' },
  },
  all: { label: 'All', query: { sort: '-opened_at' } },
};

export function ChangeList() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS[params.get('view') ?? ''] ? params.get('view')! : 'active';
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const [limit, setLimit] = useState(50);
  const list = useChanges({ ...VIEWS[view]!.query, q: query || undefined, limit });
  const navigate = useNavigate();
  usePageTitle(`Change Requests - ${VIEWS[view]!.label}`);
  const items = list.data?.items ?? [];
  return (
    <Page>
      <ListFrame
        title="Change Requests"
        newTo="/change_requests/new"
        search={
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search number, TLA, MR…"
            className="h-8 w-64 text-[13px]"
          />
        }
        crumbs={[{ label: 'All', onClick: () => setParams({ view: 'all' }) }]}
        toolbar={
          <div className="flex flex-wrap items-center gap-1.5">
            {Object.entries(VIEWS).map(([key, v]) => (
              <Button
                key={key}
                size="sm"
                variant={key === view ? 'default' : 'outline'}
                onClick={() => setParams({ view: key })}
              >
                {v.label}
              </Button>
            ))}
            <span className="ml-2 text-muted-foreground text-xs">
              Merging to main deploys to QV. KBR promotes scheduled changes to production at their
              planned start.
            </span>
          </div>
        }
        count={
          list.data ? { shown: items.length, total: list.data.total ?? items.length } : undefined
        }
        hasMore={!!list.data?.next_cursor}
        onMore={() => setLimit((n) => n + 50)}
      >
        {items.length === 0 ? (
          <EmptyState title={list.isLoading ? 'Loading…' : 'No change requests'} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead className="w-32">Number</SortHead>
                <SortHead>Short description</SortHead>
                <SortHead className="w-24">CI</SortHead>
                <SortHead className="w-24">Type</SortHead>
                <SortHead className="w-28">State</SortHead>
                <SortHead className="w-32">Planned start</SortHead>
                <SortHead className="w-32">Implemented</SortHead>
                <SortHead>Requested by</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow
                  key={c.number}
                  data-demo="change-row"
                  data-number={c.number}
                  onClick={() => navigate(`/change_requests/${c.number}`)}
                  className={cn(listRowClass, 'cursor-pointer')}
                >
                  <TableCell>
                    <Link
                      to={`/change_requests/${c.number}`}
                      className={refLinkClass}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.number}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-0 truncate">{c.short_description}</TableCell>
                  <TableCell>
                    <TlaChip app={c.app} />
                  </TableCell>
                  <TableCell>{CHANGE_TYPE_LABELS[c.type]}</TableCell>
                  <TableCell>
                    <ChangeStateBadge state={c.state} />
                  </TableCell>
                  <TableCell>{when(c.planned_start)}</TableCell>
                  <TableCell>{when(c.implemented_at)}</TableCell>
                  <TableCell>
                    <UserLink user={c.requested_by} />
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
// Detail
// ---------------------------------------------------------------------------

function KbrBanner({ change }: { change: ChangeRequest }) {
  const { release } = change;
  let tone = 'border-border bg-muted/40';
  let text: ReactNode;
  if (change.state === 'scheduled') {
    const due = change.planned_start && Date.parse(change.planned_start) <= Date.now();
    tone = 'border-warning/40 bg-warning/10';
    text = due ? (
      'Planned start has passed: KBR is picking this change up.'
    ) : (
      <>
        KBR promotes this change from QV to production{' '}
        <RelativeTime value={change.planned_start!} />.
      </>
    );
  } else if (change.state === 'implement') {
    tone = 'border-positive/40 bg-positive/10';
    text = `KBR release ${release.id ?? ''} is rolling this change out to production.`;
  } else if (change.state === 'closed') {
    text = `Implemented by KBR release ${release.id ?? ''} (${change.close_code ? CHANGE_CLOSE_CODE_LABELS[change.close_code] : 'closed'}).`;
  } else if (change.state === 'new' && release.status === 'failed') {
    tone = 'border-destructive/40 bg-destructive/10';
    text = 'The last KBR release aborted (see the work notes). Fix it, then set a planned start.';
  } else if (change.state === 'new') {
    text = 'Draft: KBR will not run until a planned start is set.';
  } else {
    text = 'Canceled.';
  }
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-(--radius) border px-3 py-2 text-[13px]',
        tone,
      )}
    >
      <Rocket className="size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

export function ChangeDetail() {
  const { number = '' } = useParams();
  const change = useChange(number);
  const update = useUpdateChange(number);
  const [reschedule, setReschedule] = useState('');
  const [note, setNote] = useState('');
  usePageTitle(number);

  if (change.isLoading)
    return (
      <Page>
        <EmptyState title="Loading…" />
      </Page>
    );
  if (!change.data)
    return (
      <Page>
        <EmptyState title={`Change request ${number} not found`} />
      </Page>
    );
  const c = change.data;
  const editable = c.state === 'new' || c.state === 'scheduled';
  const busy = update.isPending;

  const actions = editable ? (
    <>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => update.mutate({ planned_start: 'now', state: 'scheduled' })}
      >
        {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
        Promote now
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => update.mutate({ state: 'canceled' })}
      >
        Cancel change
      </Button>
    </>
  ) : undefined;

  return (
    <>
      <FormHeader
        backTo="/change_requests"
        backLabel="Back to change requests"
        recordType="Change Request"
        title={`${c.number} · ${c.short_description}`}
        actions={actions}
      />
      <Page className="space-y-4">
        <KbrBanner change={c} />
        {update.error && <div className="text-destructive text-xs">{update.error.message}</div>}
        <FormBody>
          <FormColumns>
            <FormColumn>
              <FormField label="Number">{c.number}</FormField>
              <FormField label="Configuration item">
                <TlaChip app={c.app} showName />
              </FormField>
              <FormField label="Requested by">
                <UserLink user={c.requested_by} />
              </FormField>
              <FormField label="Assignment group">
                <GroupLink group={c.assignment_group} />
              </FormField>
              <FormField label="Related incidents">
                {c.related_incidents.length === 0 ? (
                  <Muted>—</Muted>
                ) : (
                  <span className="flex flex-wrap gap-2">
                    {c.related_incidents.map((n) => (
                      <Link key={n} to={`/incidents/${n}`} className={refLinkClass}>
                        {n}
                      </Link>
                    ))}
                  </span>
                )}
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="State">
                <ChangeStateBadge state={c.state} />
              </FormField>
              <FormField label="Type">{CHANGE_TYPE_LABELS[c.type]}</FormField>
              <FormField label="Risk">{CHANGE_RISK_LABELS[c.risk]}</FormField>
              <FormField label="Planned start">
                {c.planned_start ? new Date(c.planned_start).toLocaleString() : <Muted>—</Muted>}
              </FormField>
              <FormField label="Implemented">
                {c.implemented_at ? new Date(c.implemented_at).toLocaleString() : <Muted>—</Muted>}
              </FormField>
              <FormField label="KBR release">
                {c.release.id ?? '—'} · {RELEASE_STATUS_LABELS[c.release.status]}
              </FormField>
            </FormColumn>
          </FormColumns>
          <div className="mt-2.5 grid gap-2.5">
            <FormField label="Description" multiline>
              <div className="whitespace-pre-wrap">{c.description || <Muted>—</Muted>}</div>
            </FormField>
            <FormField label="Backout plan" multiline>
              {c.backout_plan}
            </FormField>
            {c.close_notes && (
              <FormField label="Close notes" multiline>
                {c.close_notes}
              </FormField>
            )}
          </div>
        </FormBody>

        {editable && (
          <Section title="Reschedule">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="datetime-local"
                value={reschedule}
                onChange={(e) => setReschedule(e.target.value)}
                className={cn(fieldInputClass, 'w-60')}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!reschedule || busy}
                onClick={() =>
                  update.mutate({
                    planned_start: new Date(reschedule).toISOString(),
                    state: 'scheduled',
                  })
                }
              >
                Set planned start
              </Button>
            </div>
          </Section>
        )}

        <Section title={`Merge requests (${c.merge_requests.length})`} bodyClassName="p-0">
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead>Merge request</SortHead>
                <SortHead>Title</SortHead>
                <SortHead className="w-28">GitLab state</SortHead>
                <SortHead className="w-28">Merge commit</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.merge_requests.map((m) => (
                <TableRow key={m.reference} className={listRowClass}>
                  <TableCell>
                    <a
                      href={m.web_url}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(
                        refLinkClass,
                        'inline-flex items-center gap-1 font-mono text-xs',
                      )}
                    >
                      {m.reference}
                      <ExternalLink className="size-3" />
                    </a>
                  </TableCell>
                  <TableCell>{m.title ?? <Muted>Not validated by KBR yet</Muted>}</TableCell>
                  <TableCell>{m.state ?? <Muted>—</Muted>}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {m.merge_commit_sha?.slice(0, 7) ?? <Muted>—</Muted>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        {c.deployments.length > 0 && (
          <Section title="Production deployments" bodyClassName="p-0">
            <Table>
              <TableHeader>
                <TableRow className={listHeaderRowClass}>
                  <SortHead>Project</SortHead>
                  <SortHead>Workload</SortHead>
                  <SortHead className="w-28">Commit</SortHead>
                  <SortHead>Version</SortHead>
                  <SortHead>Tag</SortHead>
                  <SortHead className="w-32">Deployed</SortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.deployments.map((d) => (
                  <TableRow key={d.project} className={listRowClass}>
                    <TableCell className="font-mono text-xs">{d.project}</TableCell>
                    <TableCell>{d.service ?? <Muted>not deployed</Muted>}</TableCell>
                    <TableCell className="font-mono text-xs">{d.short_sha}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {d.version ?? <Muted>—</Muted>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.tag ?? <Muted>—</Muted>}</TableCell>
                    <TableCell>{when(d.deployed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        )}

        <Section title="Activity">
          <div className="mb-4 flex gap-2">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Work notes"
              rows={2}
              className="bg-card text-[13px] md:text-[13px]"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!note.trim() || busy}
              onClick={() => update.mutate({ work_note: note }, { onSuccess: () => setNote('') })}
            >
              Post
            </Button>
          </div>
          <ol className="space-y-3">
            {[...c.journal].reverse().map((j) => (
              <li key={j.id} className="border-l-2 pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <span className="font-medium text-foreground">{j.author.name}</span>
                  <span>
                    {j.type === 'work_note'
                      ? 'Work notes'
                      : j.type === 'comment'
                        ? 'Additional comments'
                        : 'Field changes'}
                  </span>
                  <RelativeTime value={j.created_at} />
                </div>
                <div className="mt-1 whitespace-pre-wrap">{j.text}</div>
              </li>
            ))}
          </ol>
        </Section>
      </Page>
    </>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const selectClass = cn(fieldInputClass, 'w-full');

function Hint({ children }: { children: ReactNode }) {
  return <div className="mt-1 min-h-4 text-muted-foreground text-xs">{children}</div>;
}

type When = 'now' | '+15m' | 'tonight' | 'custom';

function tonight(): string {
  const d = new Date();
  d.setHours(22, 0, 0, 0);
  if (d.getTime() < Date.now() + 30 * 60_000) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export function ChangeCreate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useCreateChange();
  const [tla, setTla] = useState((params.get('app') ?? '').toUpperCase());
  const [project, setProject] = useState(params.get('project') ?? '');
  const [iids, setIids] = useState(params.get('mr') ?? '');
  const [type, setType] = useState<ChangeType>(
    (params.get('type') as ChangeType | null) ?? (params.get('incident') ? 'emergency' : 'normal'),
  );
  const [whenChoice, setWhen] = useState<When>(params.get('incident') ? 'now' : 'tonight');
  const [custom, setCustom] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [incidents, setIncidents] = useState(params.get('incident') ?? '');
  usePageTitle('Change Request - Create');

  const debouncedTla = useDebounced(tla.trim(), 250);
  const app = useApp(debouncedTla.length >= 2 ? debouncedTla : undefined);
  const repos = app.data?.repos ?? [];
  const selectedProject = project || repos[0]?.path || '';
  const iidList = iids
    .split(/[\s,]+/)
    .map((s) => s.replace(/^!/, ''))
    .filter((s) => /^\d+$/.test(s));

  const plannedStart =
    whenChoice === 'tonight'
      ? tonight()
      : whenChoice === 'custom'
        ? custom
          ? new Date(custom).toISOString()
          : ''
        : whenChoice;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        short_description: shortDescription,
        description: description || undefined,
        app_tla: tla,
        merge_requests: iidList.map((iid) => `${selectedProject}!${iid}`),
        planned_start: plannedStart || undefined,
        type,
        requested_by: CURRENT_USER,
        related_incidents: incidents
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      { onSuccess: (chg) => navigate(`/change_requests/${chg.number}`) },
    );
  };

  const canSubmit =
    !!shortDescription.trim() &&
    !!app.data &&
    !!selectedProject &&
    iidList.length > 0 &&
    !create.isPending;
  const submitButton = (
    <Button type="submit" size="sm" disabled={!canSubmit}>
      {create.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
      Submit
    </Button>
  );

  return (
    <form onSubmit={submit}>
      <FormHeader
        backTo="/change_requests"
        backLabel="Back to change requests"
        recordType="Change Request"
        title="New record"
        actions={submitButton}
      />
      <Page>
        <FormBody className="grid gap-2.5">
          <FormColumns>
            <FormColumn>
              <FormField label="Number">
                <span className="text-muted-foreground">Assigned on submit</span>
              </FormField>
              <FormField
                label="Configuration item"
                htmlFor="tla"
                mandatory={app.data ? 'filled' : 'empty'}
                editable
              >
                <Input
                  id="tla"
                  value={tla}
                  onChange={(e) => {
                    setTla(e.target.value.toUpperCase());
                    setProject('');
                  }}
                  placeholder="Application TLA, e.g. CIF"
                  maxLength={5}
                  className={cn(fieldInputClass, 'font-mono')}
                />
                <Hint>
                  {app.data ? (
                    <span className="font-medium text-foreground">{app.data.name}</span>
                  ) : app.error && debouncedTla ? (
                    <span className="text-destructive">Unknown application {debouncedTla}</span>
                  ) : null}
                </Hint>
              </FormField>
              <FormField
                label="Project"
                htmlFor="project"
                mandatory={selectedProject ? 'filled' : 'empty'}
                editable
              >
                <NativeSelect
                  id="project"
                  value={selectedProject}
                  onChange={(e) => setProject(e.target.value)}
                  disabled={repos.length === 0}
                  className={selectClass}
                >
                  {repos.length === 0 && <option value="">Pick an application first</option>}
                  {repos.map((r) => (
                    <option key={r.path} value={r.path}>
                      {r.path}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField
                label="Merge requests"
                htmlFor="mrs"
                mandatory={iidList.length > 0 ? 'filled' : 'empty'}
                editable
              >
                <Input
                  id="mrs"
                  value={iids}
                  onChange={(e) => setIids(e.target.value)}
                  placeholder="MR numbers, e.g. 12, 14"
                  className={cn(fieldInputClass, 'font-mono')}
                />
                <Hint>
                  {iidList.length > 0
                    ? iidList.map((i) => `${selectedProject}!${i}`).join(', ')
                    : 'Merged MRs to promote together. KBR rejects any that are not merged.'}
                </Hint>
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="State">{plannedStart ? 'Scheduled' : 'New'}</FormField>
              <FormField label="Type" htmlFor="type" editable>
                <NativeSelect
                  id="type"
                  value={type}
                  onChange={(e) => setType(e.target.value as ChangeType)}
                  className={selectClass}
                >
                  {CHANGE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {CHANGE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Planned start" htmlFor="when" editable>
                <NativeSelect
                  id="when"
                  value={whenChoice}
                  onChange={(e) => setWhen(e.target.value as When)}
                  className={selectClass}
                >
                  <option value="now">Now (next KBR run)</option>
                  <option value="+15m">In 15 minutes</option>
                  <option value="tonight">Tonight's release window (22:00)</option>
                  <option value="custom">Pick a date and time…</option>
                </NativeSelect>
                {whenChoice === 'custom' && (
                  <Input
                    type="datetime-local"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    className={cn(fieldInputClass, 'mt-2')}
                  />
                )}
                <Hint>KBR launches automatically at this time and promotes QV to production.</Hint>
              </FormField>
              <FormField label="Related incidents" htmlFor="incidents" editable>
                <Input
                  id="incidents"
                  value={incidents}
                  onChange={(e) => setIncidents(e.target.value.toUpperCase())}
                  placeholder="e.g. INC0010205"
                  className={cn(fieldInputClass, 'font-mono')}
                />
              </FormField>
            </FormColumn>
          </FormColumns>
          <div className="mt-2 grid gap-2.5">
            <FormField
              label="Short description"
              htmlFor="short-description"
              mandatory={shortDescription.trim() ? 'filled' : 'empty'}
              editable
            >
              <Input
                id="short-description"
                value={shortDescription}
                onChange={(e) => setShortDescription(e.target.value)}
                maxLength={160}
                required
                placeholder="e.g. CIF - restore snake_case JSON naming"
                className={fieldInputClass}
              />
            </FormField>
            <FormField label="Description" htmlFor="description" editable multiline>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                className="min-h-24 bg-card text-[13px] md:text-[13px]"
              />
            </FormField>
          </div>
        </FormBody>
        <div className="flex items-center justify-start gap-2">
          {submitButton}
          <Button type="button" variant="outline" size="sm" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          {create.error && <span className="text-destructive text-xs">{create.error.message}</span>}
        </div>
      </Page>
    </form>
  );
}
