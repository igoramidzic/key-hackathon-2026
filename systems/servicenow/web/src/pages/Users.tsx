import { GROUP_TYPE_LABELS } from '@sim/contracts/servicenow';
import {
  cn,
  EmptyState,
  ErrorState,
  Spinner,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  UserAvatar,
  useDebounced,
} from '@sim/ui';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useIncidents, useUser, useUsers } from '../api';
import { Muted, refLinkClass, TlaChip, UserLink } from '../components/bits';
import { FormBody, FormColumn, FormColumns, FormField, FormHeader } from '../components/form';
import { IncidentTable } from '../components/IncidentTable';
import { Page, usePageTitle } from '../components/Layout';
import {
  type Crumb,
  ListFrame,
  ListSearch,
  listHeaderRowClass,
  listRowClass,
  RelatedLists,
  SortHead,
  useClientSort,
} from '../components/list';

const PAGE = 50;

export function UserList() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const query = useDebounced(q, 200);
  const { data, error, isLoading } = useUsers({ q: query || undefined, limit });
  const { sorted, head } = useClientSort(
    data?.items,
    {
      name: (u) => u.name,
      username: (u) => u.username,
      title: (u) => u.title,
      department: (u) => u.department,
      email: (u) => u.email,
      location: (u) => u.location,
    },
    'name',
  );

  const crumbs: Crumb[] = [{ label: 'All', onClick: () => setQ('') }];
  if (query) crumbs.push({ label: `Keywords = ${query}` });

  return (
    <Page>
      <ListFrame
        title="Users"
        search={
          <ListSearch
            autoFocus
            value={q}
            onChange={(v) => {
              setQ(v);
              setLimit(PAGE);
            }}
            placeholder="Search name, username, email or title…"
            label="Search people"
          />
        }
        crumbs={crumbs}
        count={
          data ? { shown: data.items.length, total: data.total ?? data.items.length } : undefined
        }
        hasMore={!!data?.next_cursor}
        onMore={() => setLimit((l) => l + PAGE)}
      >
        {error ? (
          <div className="p-3">
            <ErrorState error={error} />
          </div>
        ) : isLoading || !sorted ? (
          <Spinner />
        ) : sorted.length === 0 ? (
          <EmptyState title="No people match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead {...head('name')}>Name</SortHead>
                <SortHead {...head('username')}>User ID</SortHead>
                <SortHead {...head('title')}>Title</SortHead>
                <SortHead {...head('department')}>Department</SortHead>
                <SortHead {...head('email')}>Email</SortHead>
                <SortHead {...head('location')}>Location</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((u) => (
                <TableRow
                  key={u.username}
                  onClick={() => navigate(`/users/${u.username}`)}
                  className={cn(listRowClass, 'cursor-pointer')}
                >
                  <TableCell>
                    <Link
                      to={`/users/${u.username}`}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(refLinkClass, 'inline-flex items-center gap-2')}
                    >
                      <UserAvatar name={u.name} size="xs" />
                      {u.name}
                    </Link>
                  </TableCell>
                  <TableCell>{u.username}</TableCell>
                  <TableCell>{u.title}</TableCell>
                  <TableCell>{u.department}</TableCell>
                  <TableCell className="text-muted-foreground">{u.email}</TableCell>
                  <TableCell>{u.location}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListFrame>
    </Page>
  );
}

export function UserDetail() {
  const { username = '' } = useParams();
  const { data: user, error, isLoading } = useUser(username);
  const incidents = useIncidents({ assigned_to: username, active: true, limit: 50 });
  usePageTitle(user ? `User - ${user.name}` : undefined);

  if (isLoading) return <Spinner label="Loading person" />;
  if (error || !user) {
    return (
      <Page>
        <ErrorState error={error ?? `User ${username} not found`} />
      </Page>
    );
  }

  return (
    <div>
      <FormHeader backTo="/users" backLabel="Back to users" recordType="User" title={user.name} />
      <Page>
        <FormBody>
          <div className="flex flex-col gap-6 lg:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-2 lg:w-40">
              <UserAvatar name={user.name} size="lg" className="size-24 text-2xl" />
              <div className="text-center text-[13px]">
                <div className="font-semibold text-foreground">{user.name}</div>
                <div className="text-muted-foreground">{user.title}</div>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <FormColumns>
                <FormColumn>
                  <FormField label="User ID">{user.username}</FormField>
                  <FormField label="Name">{user.name}</FormField>
                  <FormField label="Title">{user.title}</FormField>
                  <FormField label="Department">{user.department}</FormField>
                  <FormField
                    label="Manager"
                    href={user.manager?.web_url ? `/users/${user.manager.username}` : undefined}
                  >
                    <UserLink user={user.manager} />
                  </FormField>
                </FormColumn>
                <FormColumn>
                  <FormField label="Email">
                    <a href={`mailto:${user.email}`} className={refLinkClass}>
                      {user.email}
                    </a>
                  </FormField>
                  <FormField label="Business phone">
                    <span className="tabular-nums">{user.phone}</span>
                  </FormField>
                  <FormField label="Location">{user.location}</FormField>
                  <FormField label="Time zone">{user.timezone}</FormField>
                  <FormField label="Role">{user.role.replace(/_/g, ' ')}</FormField>
                </FormColumn>
              </FormColumns>
            </div>
          </div>
        </FormBody>

        <RelatedLists
          lists={[
            {
              id: 'incidents',
              label: 'Open Incidents Assigned',
              count: user.open_assigned_incident_count,
              content: incidents.data ? (
                <IncidentTable items={incidents.data.items} empty="Nothing assigned" />
              ) : (
                <Spinner />
              ),
            },
            {
              id: 'groups',
              label: 'Groups',
              count: user.groups.length,
              content:
                user.groups.length === 0 ? (
                  <div className="p-4">
                    <Muted>Not a member of any group</Muted>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className={listHeaderRowClass}>
                        <SortHead>Group</SortHead>
                        <SortHead>Type</SortHead>
                        <SortHead>Role</SortHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {user.groups.map((g) => (
                        <TableRow key={g.id} className={listRowClass}>
                          <TableCell>
                            <Link to={`/groups/${g.id}`} className={refLinkClass}>
                              {g.name}
                            </Link>
                          </TableCell>
                          <TableCell>{GROUP_TYPE_LABELS[g.type]}</TableCell>
                          <TableCell className="w-full">
                            <span className="flex flex-wrap gap-1">
                              {g.is_manager && <StatusBadge>Manager</StatusBadge>}
                              {g.on_call && (
                                <StatusBadge tone="positive">On call · {g.on_call}</StatusBadge>
                              )}
                              {!g.is_manager && !g.on_call && <Muted>Member</Muted>}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ),
            },
            ...(user.supported_apps.length > 0
              ? [
                  {
                    id: 'supports',
                    label: 'Supports',
                    count: user.supported_apps.length,
                    content: (
                      <div className="flex flex-wrap gap-1.5 p-4">
                        {user.supported_apps.map((a) => (
                          <TlaChip key={a.tla} app={a} />
                        ))}
                      </div>
                    ),
                  },
                ]
              : []),
            ...(user.owned_apps.length > 0
              ? [
                  {
                    id: 'owns',
                    label: 'Owns',
                    count: user.owned_apps.length,
                    content: (
                      <div className="flex flex-wrap gap-1.5 p-4">
                        {user.owned_apps.map((a) => (
                          <TlaChip key={a.tla} app={a} />
                        ))}
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Page>
    </div>
  );
}
