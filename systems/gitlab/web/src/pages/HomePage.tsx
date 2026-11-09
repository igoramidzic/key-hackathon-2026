import type { GitlabEvent } from '@sim/contracts/gitlab';
import { Input } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  EntityAvatar,
  Loadable,
  PageTitle,
  Section,
  TabsRow,
  tabClassName,
} from '../components/common';
import { SearchBox } from '../components/Layout';
import { EventFeed } from '../components/lists';
import { api } from '../lib/api';

type Filter = 'all' | 'merged' | 'pushed' | 'opened';

const matches = (e: GitlabEvent, f: Filter) =>
  f === 'all' ||
  (f === 'merged' && e.action_name === 'merged') ||
  (f === 'opened' && (e.action_name === 'opened' || e.action_name === 'reopened')) ||
  (f === 'pushed' && e.action_name.startsWith('pushed'));

function GroupsCard() {
  const [filter, setFilter] = useState('');
  const groups = useQuery({
    queryKey: ['groups', 'all'],
    queryFn: () => api.listGroups({ limit: 500 }),
  });
  const term = filter.trim().toLowerCase();
  return (
    <Section
      title={
        <span>
          Groups{' '}
          <span className="ml-1 inline-flex h-5 items-center rounded-full bg-muted px-2 font-normal text-[12px] text-muted-foreground tabular-nums">
            {groups.data ? groups.data.items.length - 1 : ''}
          </span>
        </span>
      }
      actions={
        <Link to="/keybank" className="text-gl-link text-xs hover:underline">
          View all
        </Link>
      }
    >
      <div className="border-b p-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by TLA or app name"
          aria-label="Filter groups"
        />
      </div>
      <Loadable query={groups}>
        {(page) => (
          <ul className="max-h-[600px] divide-y overflow-y-auto">
            {page.items
              .filter((g) => g.tla)
              .filter(
                (g) =>
                  !term ||
                  g.full_path.toLowerCase().includes(term) ||
                  g.description.toLowerCase().includes(term),
              )
              .map((g) => (
                <li key={g.id}>
                  <Link
                    to={`/${g.full_path}`}
                    className="flex items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-gl-subtle"
                  >
                    <EntityAvatar name={g.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-gl-strong">{g.name}</span>
                      <span className="block truncate text-muted-foreground">{g.description}</span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">{g.projects_count}</span>
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </Loadable>
    </Section>
  );
}

export function HomePage() {
  const [filter, setFilter] = useState<Filter>('all');
  const events = useQuery({
    queryKey: ['events', 'home'],
    queryFn: () => api.listEvents({ limit: 150 }),
    refetchInterval: 4_000,
  });
  const items = useMemo(
    () => (events.data?.items ?? []).filter((e) => matches(e, filter)).slice(0, 60),
    [events.data, filter],
  );
  return (
    <div className="grid gap-4">
      <PageTitle
        description={
          <>
            KeyBank GitLab: one group per application,{' '}
            <code className="rounded-(--radius) bg-muted px-1 font-mono text-[13px]">
              keybank/&lt;TLA&gt;00
            </code>
            , matching the ServiceNow application catalog.
          </>
        }
        actions={<SearchBox autoFocus className="w-full sm:w-96" />}
      >
        Activity
      </PageTitle>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <TabsRow label="Activity filter">
            {(
              [
                { value: 'all', label: 'All' },
                { value: 'pushed', label: 'Push events' },
                { value: 'merged', label: 'Merge events' },
                { value: 'opened', label: 'Opened' },
              ] as const
            ).map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={filter === t.value}
                onClick={() => setFilter(t.value)}
                className={tabClassName(filter === t.value)}
              >
                {t.label}
              </button>
            ))}
          </TabsRow>
          <Loadable query={events}>{() => <EventFeed events={items} />}</Loadable>
        </div>
        <GroupsCard />
      </div>
    </div>
  );
}
