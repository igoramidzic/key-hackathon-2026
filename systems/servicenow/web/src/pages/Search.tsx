import { cn, Spinner, UserAvatar } from '@sim/ui';
import { Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useApps, useGroups, useIncidents, useUsers } from '../api';
import { Muted, refLinkClass, Section, TierBadge, TlaChip } from '../components/bits';
import { IncidentTable } from '../components/IncidentTable';
import { Page, usePageTitle } from '../components/Layout';

/** Global search results across incidents, applications, groups and people. */
export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const incidents = useIncidents({ q, limit: 10 }, false);
  const apps = useApps({ q, limit: 10 });
  const groups = useGroups({ q, limit: 10 });
  const users = useUsers({ q, limit: 10 });
  usePageTitle(`Search - ${q}`);

  return (
    <Page>
      <div className="flex items-center gap-3 rounded-(--radius) border bg-card px-4 py-3">
        <Search className="size-5 text-muted-foreground" />
        <h1 className="font-bold text-[17px]">Search results for “{q}”</h1>
        <span className="ml-auto text-[13px] text-muted-foreground">
          Incidents · Business Applications · Groups · Users
        </span>
      </div>
      <Section title={`Incidents (${incidents.data?.total ?? 0})`} bodyClassName="p-0">
        {incidents.data ? (
          <IncidentTable items={incidents.data.items} empty="No incidents match" />
        ) : (
          <Spinner />
        )}
      </Section>
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Section title={`Business Applications (${apps.data?.total ?? 0})`}>
          <ul className="space-y-2 text-[13px]">
            {apps.data?.items.map((a) => (
              <li key={a.tla} className="flex items-center gap-2">
                <TlaChip app={a} />
                <Link to={`/apps/${a.tla}`} className={cn(refLinkClass, 'min-w-0 flex-1 truncate')}>
                  {a.name}
                </Link>
                <TierBadge tier={a.tier} />
              </li>
            ))}
            {apps.data?.items.length === 0 && (
              <li>
                <Muted>No matches</Muted>
              </li>
            )}
          </ul>
        </Section>
        <Section title={`Groups (${groups.data?.total ?? 0})`}>
          <ul className="space-y-2 text-[13px]">
            {groups.data?.items.map((g) => (
              <li key={g.id}>
                <Link to={`/groups/${g.id}`} className={refLinkClass}>
                  {g.name}
                </Link>
              </li>
            ))}
            {groups.data?.items.length === 0 && (
              <li>
                <Muted>No matches</Muted>
              </li>
            )}
          </ul>
        </Section>
        <Section title={`Users (${users.data?.total ?? 0})`}>
          <ul className="space-y-2 text-[13px]">
            {users.data?.items.map((u) => (
              <li key={u.username} className="flex items-center gap-2">
                <UserAvatar name={u.name} size="xs" />
                <Link to={`/users/${u.username}`} className={refLinkClass}>
                  {u.name}
                </Link>
                <span className="truncate text-muted-foreground">{u.title}</span>
              </li>
            ))}
            {users.data?.items.length === 0 && (
              <li>
                <Muted>No matches</Muted>
              </li>
            )}
          </ul>
        </Section>
      </div>
    </Page>
  );
}
