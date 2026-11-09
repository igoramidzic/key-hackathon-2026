import { Button, EmptyState, UserAvatar } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Loadable, refChip, TabsRow, tabClassName } from '../components/common';
import { EventFeed } from '../components/lists';
import { api, ORG } from '../lib/api';

export function UserPage() {
  const { username = '' } = useParams();
  const user = useQuery({
    queryKey: ['user', username],
    queryFn: () => api.getUser(username),
    retry: false,
  });
  const events = useQuery({
    queryKey: ['events', 'user', username],
    queryFn: () => api.listEvents({ author: username, limit: 40 }),
    refetchInterval: 5_000,
  });
  return (
    <Loadable query={user}>
      {(u) => (
        <div className="grid gap-0">
          <div className="flex items-center gap-4 pb-4">
            <UserAvatar name={u.name} size="lg" className="size-24 text-2xl" />
            <div className="grid gap-1">
              <h1 className="font-semibold text-2xl text-gl-strong">{u.name}</h1>
              <div className="text-muted-foreground text-xs">
                @{u.username} · {u.job_title}
              </div>
              {u.groups.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {u.groups.map((t) => (
                    <Link key={t} to={`/${ORG}/${t}00`} className={refChip}>
                      {t}00
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
          <TabsRow label="Profile">
            <span aria-current="page" className={tabClassName(true)}>
              Activity
            </span>
          </TabsRow>
          <Loadable query={events}>{(page) => <EventFeed events={page.items} />}</Loadable>
        </div>
      )}
    </Loadable>
  );
}

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="Make sure the address is correct and the page hasn't moved."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/">Go home</Link>
        </Button>
      }
    />
  );
}
