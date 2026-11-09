import {
  type IncidentListQuery,
  type IncidentSort,
  type Priority,
  STATE_LABELS,
} from '@sim/contracts/servicenow';
import {
  ErrorState,
  NativeSelect,
  Spinner,
  StatusDot,
  Tabs,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
  useDebounced,
} from '@sim/ui';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CURRENT_USER, CURRENT_USER_NAME, useIncidents } from '../api';
import { PRIORITY_TONES } from '../components/bits';
import { IncidentTable } from '../components/IncidentTable';
import { Page, usePageTitle } from '../components/Layout';
import { type Crumb, ListFrame, ListSearch } from '../components/list';

type View = 'open' | 'all' | 'mine' | 'unassigned';

const VIEWS: { value: View; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'all', label: 'All' },
];

const PAGE = 50;
const DEFAULT_SORT: IncidentSort = '-opened_at';

export function IncidentList() {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View | null) ?? 'open';
  const priorities = (params.get('priority') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number) as Priority[];
  const state = params.get('state') ?? '';
  const sort = (params.get('sort') as IncidentSort | null) ?? DEFAULT_SORT;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q, 250);
  const [limit, setLimit] = useState(PAGE);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
    setLimit(PAGE);
  };

  const query: IncidentListQuery = {
    limit,
    q: debouncedQ || undefined,
    priority: priorities.length ? priorities : undefined,
    sort,
  };
  if (view === 'open') query.active = true;
  if (view === 'mine') {
    query.assigned_to = CURRENT_USER;
    query.active = true;
  }
  if (view === 'unassigned') {
    query.assigned_to = 'none';
    query.active = true;
  }
  if (view === 'all' && state) query.state = [state as never];

  const { data, error, isLoading } = useIncidents(query);
  usePageTitle(
    view === 'mine'
      ? 'Incidents - Assigned to me'
      : view === 'all'
        ? 'Incidents - All'
        : 'Incidents',
  );

  // Filter breadcrumb from the active conditions. Clicking a crumb removes every condition after it.
  type Condition = { label: string; drop: Record<string, string | null> | 'q' };
  const conditions: Condition[] = [];
  if (view !== 'all') conditions.push({ label: 'Active = true', drop: { view: 'all' } });
  if (view === 'mine')
    conditions.push({ label: `Assigned to = ${CURRENT_USER_NAME}`, drop: { view: 'open' } });
  if (view === 'unassigned')
    conditions.push({ label: 'Assigned to is empty', drop: { view: 'open' } });
  if (view === 'all' && state)
    conditions.push({ label: `State = ${STATE_LABELS[state as never]}`, drop: { state: null } });
  if (priorities.length)
    conditions.push({
      label:
        priorities.length === 1
          ? `Priority = ${priorities[0]}`
          : `Priority in ${priorities.join(', ')}`,
      drop: { priority: null },
    });
  if (debouncedQ) conditions.push({ label: `Keywords = ${debouncedQ}`, drop: 'q' });

  const dropAfter = (index: number) => {
    let patch: Record<string, string | null> = {};
    // Walk from the last condition back so earlier view changes win.
    for (const c of conditions.slice(index + 1).reverse()) {
      if (c.drop === 'q') setQ('');
      else patch = { ...patch, ...c.drop };
    }
    if (Object.keys(patch).length) update(patch);
  };

  const crumbs: Crumb[] = [
    {
      label: 'All',
      onClick: () => {
        setQ('');
        update({ view: 'all', state: null, priority: null });
      },
    },
    ...conditions.map((c, i) => ({ label: c.label, onClick: () => dropAfter(i) })),
  ];

  return (
    <Page>
      <ListFrame
        title="Incidents"
        newTo="/incidents/new"
        search={
          <ListSearch
            value={q}
            onChange={(v) => {
              setQ(v);
              setLimit(PAGE);
            }}
            placeholder="Search number, description, app…"
            label="Search incidents"
          />
        }
        crumbs={crumbs}
        count={
          data ? { shown: data.items.length, total: data.total ?? data.items.length } : undefined
        }
        hasMore={!!data?.next_cursor}
        onMore={() => setLimit((l) => l + PAGE)}
        toolbar={
          <>
            <Tabs value={view} onValueChange={(v) => update({ view: v, state: null })}>
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
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <span className="text-[13px] text-muted-foreground">Priority</span>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Priority"
              value={priorities.map(String)}
              onValueChange={(values) => update({ priority: [...values].sort().join(',') || null })}
            >
              {([1, 2, 3, 4, 5] as Priority[]).map((p) => (
                <ToggleGroupItem
                  key={p}
                  value={String(p)}
                  aria-label={`Priority ${p}`}
                  className="h-7 px-2 text-[13px] data-[state=on]:bg-accent data-[state=on]:text-foreground"
                >
                  <StatusDot tone={PRIORITY_TONES[p]} className="size-2 rounded-full" />
                  {p}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {view === 'all' && (
              <NativeSelect
                aria-label="State"
                value={state}
                onChange={(e) => update({ state: e.target.value || null })}
                className="h-7 w-36 bg-card text-[13px]"
              >
                <option value="">Any state</option>
                {Object.entries(STATE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            )}
            <span className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" />
                <StatusDot tone="positive" className="relative rounded-full" />
              </span>
              Auto-refresh every 5 seconds
            </span>
          </>
        }
      >
        {error ? (
          <div className="p-3">
            <ErrorState error={error} />
          </div>
        ) : isLoading || !data ? (
          <Spinner />
        ) : (
          <IncidentTable
            items={data.items}
            empty={view === 'mine' ? 'Nothing assigned to you' : 'No incidents match'}
            sort={sort}
            onSort={(s) => update({ sort: s === DEFAULT_SORT ? null : s })}
          />
        )}
      </ListFrame>
    </Page>
  );
}
