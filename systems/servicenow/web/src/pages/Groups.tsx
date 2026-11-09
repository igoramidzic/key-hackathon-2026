import { GROUP_TYPE_LABELS, type GroupType } from '@sim/contracts/servicenow';
import {
  cn,
  EmptyState,
  ErrorState,
  NativeSelect,
  Spinner,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  useDebounced,
} from '@sim/ui';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useGroup, useGroups, useIncidents } from '../api';
import { Eyebrow, Muted, refLinkClass, Section, TlaChip, UserLink } from '../components/bits';
import { ContactCard } from '../components/ContactCard';
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

const PAGE = 60;

export function GroupList() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const query = useDebounced(q, 200);
  const { data, error, isLoading } = useGroups({
    q: query || undefined,
    type: (type || undefined) as GroupType | undefined,
    limit,
  });
  const { sorted, head } = useClientSort(
    data?.items,
    {
      name: (g) => g.name,
      type: (g) => GROUP_TYPE_LABELS[g.type],
      manager: (g) => g.manager?.name ?? '',
      oncall: (g) => g.on_call.primary?.name ?? '',
      members: (g) => g.member_count,
      apps: (g) => g.app_count,
    },
    'name',
  );

  const crumbs: Crumb[] = [
    {
      label: 'All',
      onClick: () => {
        setType('');
        setQ('');
      },
    },
  ];
  if (type)
    crumbs.push({
      label: `Type = ${GROUP_TYPE_LABELS[type as GroupType]}`,
      onClick: () => setQ(''),
    });
  if (query) crumbs.push({ label: `Keywords = ${query}` });

  return (
    <Page>
      <ListFrame
        title="Groups"
        search={
          <ListSearch
            value={q}
            onChange={setQ}
            placeholder="Search name or supported TLA…"
            label="Search groups"
          />
        }
        crumbs={crumbs}
        toolbar={
          <>
            <span className="text-[13px] text-muted-foreground">Type</span>
            <NativeSelect
              aria-label="Group type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-7 w-52 bg-card text-[13px]"
            >
              <option value="">All types</option>
              {Object.entries(GROUP_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
            <span className="ml-auto text-[13px] text-muted-foreground">
              Assignment groups with their manager and on-call rota.
            </span>
          </>
        }
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
          <EmptyState title="No groups match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead {...head('name')}>Name</SortHead>
                <SortHead {...head('type')}>Type</SortHead>
                <SortHead {...head('manager')}>Manager</SortHead>
                <SortHead {...head('oncall')}>On call (primary)</SortHead>
                <SortHead className="w-28" {...head('members')}>
                  Members
                </SortHead>
                <SortHead className="w-24" {...head('apps')}>
                  Apps
                </SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((g) => (
                <TableRow
                  key={g.id}
                  onClick={() => navigate(`/groups/${g.id}`)}
                  className={cn(listRowClass, 'cursor-pointer')}
                >
                  <TableCell>
                    <Link
                      to={`/groups/${g.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className={refLinkClass}
                    >
                      {g.name}
                    </Link>
                  </TableCell>
                  <TableCell>{GROUP_TYPE_LABELS[g.type]}</TableCell>
                  <TableCell>
                    <UserLink user={g.manager} />
                  </TableCell>
                  <TableCell>
                    <UserLink user={g.on_call.primary} />
                  </TableCell>
                  <TableCell className="tabular-nums">{g.member_count}</TableCell>
                  <TableCell className="tabular-nums">{g.app_count || <Muted>—</Muted>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListFrame>
    </Page>
  );
}

export function GroupDetail() {
  const { id = '' } = useParams();
  const { data: group, error, isLoading } = useGroup(id);
  const incidents = useIncidents({ assignment_group: id, active: true, limit: 50 });
  usePageTitle(group ? `Group - ${group.name}` : undefined);

  if (isLoading) return <Spinner label="Loading group" />;
  if (error || !group) {
    return (
      <Page>
        <ErrorState error={error ?? `Group ${id} not found`} />
      </Page>
    );
  }
  const onCall = new Map([
    [group.on_call.primary.username, 'Primary on call'],
    [group.on_call.secondary.username, 'Secondary on call'],
  ]);

  return (
    <div>
      <FormHeader
        backTo="/groups"
        backLabel="Back to groups"
        recordType="Group"
        title={group.name}
      />
      <Page>
        <FormBody className="grid gap-2.5">
          <FormColumns>
            <FormColumn>
              <FormField label="Name">{group.name}</FormField>
              <FormField label="Type">{GROUP_TYPE_LABELS[group.type]}</FormField>
              <FormField label="Group email">
                <a
                  href={`mailto:${group.email}`}
                  className={cn(refLinkClass, 'inline-flex items-center gap-1.5')}
                >
                  <Mail className="size-3.5" />
                  {group.email}
                </a>
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="Manager" href={`/users/${group.manager.username}`}>
                <UserLink user={group.manager} />
              </FormField>
              <FormField label="Sys ID">
                <span className="font-mono">{group.id}</span>
              </FormField>
              <FormField label="Open incidents">{group.open_incident_count}</FormField>
            </FormColumn>
          </FormColumns>
          <div className="mt-2">
            <FormField label="Description" multiline>
              {group.description}
            </FormField>
          </div>
        </FormBody>

        <Section title="On-call rota">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <Eyebrow>Primary on call</Eyebrow>
              <ContactCard person={group.on_call.primary} label="Primary" />
            </div>
            <div>
              <Eyebrow>Secondary on call</Eyebrow>
              <ContactCard person={group.on_call.secondary} label="Secondary" />
            </div>
            <div>
              <Eyebrow>Manager</Eyebrow>
              <ContactCard person={group.manager} label="Manager" />
            </div>
          </div>
        </Section>

        <RelatedLists
          lists={[
            {
              id: 'members',
              label: 'Group Members',
              count: group.members.length,
              content: (
                <Table>
                  <TableHeader>
                    <TableRow className={listHeaderRowClass}>
                      <SortHead>Name</SortHead>
                      <SortHead>Title</SortHead>
                      <SortHead>Email</SortHead>
                      <SortHead>Phone</SortHead>
                      <SortHead>On call</SortHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.members.map((m) => (
                      <TableRow key={m.username} className={listRowClass}>
                        <TableCell>
                          <UserLink user={m} avatar />
                        </TableCell>
                        <TableCell>{m.title}</TableCell>
                        <TableCell>{m.email}</TableCell>
                        <TableCell className="tabular-nums">{m.phone}</TableCell>
                        <TableCell>
                          {onCall.has(m.username) && (
                            <StatusBadge
                              tone={
                                m.username === group.on_call.primary.username
                                  ? 'positive'
                                  : 'neutral'
                              }
                            >
                              {onCall.get(m.username)}
                            </StatusBadge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ),
            },
            {
              id: 'incidents',
              label: 'Open Incidents',
              count: group.open_incident_count,
              content: incidents.data ? (
                <IncidentTable
                  items={incidents.data.items}
                  empty="No open incidents for this group"
                />
              ) : (
                <Spinner />
              ),
            },
            ...(group.apps.length > 0
              ? [
                  {
                    id: 'apps',
                    label: 'Supported Applications',
                    count: group.apps.length,
                    content: (
                      <div className="flex flex-wrap gap-1.5 p-4">
                        {group.apps.map((a) => (
                          <TlaChip key={a.tla} app={a} showName />
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
