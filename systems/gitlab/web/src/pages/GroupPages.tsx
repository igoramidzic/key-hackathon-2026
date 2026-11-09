import { URLS } from '@sim/contracts';
import type { MergeRequestState } from '@sim/contracts/gitlab';
import { Input, RelativeTime, UserAvatar } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitMerge } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  CopyButton,
  EntityAvatar,
  glLink,
  Loadable,
  StackBadge,
  TabCount,
  TabsRow,
  tabClassName,
} from '../components/common';
import { MrList } from '../components/lists';
import { api, ORG } from '../lib/api';

export function RootGroupPage() {
  const [filter, setFilter] = useState('');
  const groups = useQuery({
    queryKey: ['groups', 'all'],
    queryFn: () => api.listGroups({ limit: 500 }),
  });
  const term = filter.trim().toLowerCase();
  return (
    <div className="grid gap-0">
      <GroupHeader
        name="KeyBank"
        description={
          <>
            Application groups, named <code className="font-mono">&lt;TLA&gt;00</code> after the
            ServiceNow application code.
          </>
        }
      />
      <TabsRow
        label="Group content"
        actions={
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by TLA or application name"
            aria-label="Filter groups"
            className="w-72"
          />
        }
      >
        <span aria-current="page" className={tabClassName(true)}>
          Subgroups and projects
          <TabCount
            value={groups.data ? groups.data.items.filter((g) => g.tla).length : undefined}
          />
        </span>
      </TabsRow>
      <Loadable query={groups}>
        {(page) => (
          <div>
            <ul className="divide-y border-b">
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
                      className="flex items-center gap-3 px-4 py-3 text-xs transition-colors hover:bg-gl-subtle"
                    >
                      <EntityAvatar name={g.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-gl-strong">{g.name}</span>
                        <span className="block truncate text-muted-foreground">
                          {g.description}
                        </span>
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {g.projects_count} project{g.projects_count === 1 ? '' : 's'}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </Loadable>
    </div>
  );
}

function GroupHeader({
  name,
  id,
  description,
  children,
}: {
  name: string;
  id?: number;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 border-b pb-4">
      <EntityAvatar name={name} size="lg" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h1 className="font-semibold text-2xl text-gl-strong">{name}</h1>
        {id !== undefined && (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
            Group ID: {id}
            <CopyButton text={String(id)} label="Copy group ID" />
          </span>
        )}
        {description && <p className="mt-1 text-foreground text-xs">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function GroupPage() {
  const { group = '' } = useParams();
  const fullPath = `${ORG}/${group}`;
  const [state, setState] = useState<MergeRequestState | 'all'>('all');
  const detail = useQuery({ queryKey: ['group', group], queryFn: () => api.getGroup(fullPath) });
  const projects = useQuery({
    queryKey: ['group-projects', group],
    queryFn: () => api.listGroupProjects(fullPath, { limit: 100 }),
    refetchInterval: 10_000,
  });
  const mrs = useQuery({
    queryKey: ['group-mrs', group, state],
    queryFn: () => api.listGroupMergeRequests(fullPath, { state, limit: 20 }),
    refetchInterval: 5_000,
  });
  // The sidebar's "Merge requests" item links to #merge-requests on this page.
  const { hash } = useLocation();
  const ready = detail.isSuccess;
  useEffect(() => {
    if (ready && hash === '#merge-requests') {
      document.getElementById('merge-requests')?.scrollIntoView({ block: 'start' });
    }
  }, [hash, ready]);
  return (
    <Loadable query={detail}>
      {(g) => (
        <div className="grid gap-0">
          <GroupHeader name={g.name} id={g.id} description={g.description}>
            <div className="flex flex-col items-end gap-2">
              {g.members.length > 0 && (
                <div className="flex items-center gap-2">
                  <div className="flex -space-x-1.5">
                    {g.members.slice(0, 8).map((m) => (
                      <Link
                        key={m.username}
                        to={`/${m.username}`}
                        title={`${m.name} (${m.access_level_name})`}
                      >
                        <UserAvatar name={m.name} size="sm" className="ring-2 ring-background" />
                      </Link>
                    ))}
                  </div>
                  <span className="text-muted-foreground text-xs">{g.members.length} members</span>
                </div>
              )}
              {g.tla && (
                <a
                  href={`${URLS.servicenow.web}/apps/${g.tla}`}
                  className={`${glLink} inline-flex items-center gap-1 text-xs`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ServiceNow app {g.tla}
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </GroupHeader>

          <TabsRow label="Group content">
            <span aria-current="page" className={tabClassName(true)}>
              Subgroups and projects
              <TabCount value={g.projects_count} />
            </span>
          </TabsRow>
          <Loadable query={projects}>
            {(page) => (
              <ul className="divide-y border-b">
                {page.items.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={`/${p.path_with_namespace}`}
                      className="flex items-center gap-3 px-4 py-3 text-xs transition-colors hover:bg-gl-subtle"
                    >
                      <EntityAvatar name={p.name} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-semibold text-gl-strong">{p.name}</span>
                          <StackBadge stack={p.stack} />
                        </span>
                        <span className="mt-0.5 block truncate text-muted-foreground">
                          {p.description}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1 text-muted-foreground">
                        {p.open_merge_requests_count > 0 && (
                          <span
                            className="inline-flex items-center gap-1"
                            title="Open merge requests"
                          >
                            <GitMerge className="size-4" />
                            {p.open_merge_requests_count}
                          </span>
                        )}
                        <span>
                          Updated <RelativeTime value={p.last_activity_at} />
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>

          <section id="merge-requests" className="scroll-mt-16 pt-8">
            <h2 className="pb-2 font-semibold text-base text-gl-strong">Merge requests</h2>
            <TabsRow label="Merge request state">
              {(
                [
                  { value: 'all', label: 'All' },
                  { value: 'opened', label: 'Open' },
                  { value: 'merged', label: 'Merged' },
                ] as const
              ).map((t) => (
                <button
                  key={t.value}
                  type="button"
                  aria-pressed={state === t.value}
                  onClick={() => setState(t.value)}
                  className={tabClassName(state === t.value)}
                >
                  {t.label}
                  {t.value === state && mrs.data && <TabCount value={mrs.data.total} />}
                </button>
              ))}
            </TabsRow>
            <Loadable query={mrs}>{(page) => <MrList items={page.items} showProject />}</Loadable>
          </section>
        </div>
      )}
    </Loadable>
  );
}
