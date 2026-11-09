import type { AppRef, AppTier } from '@sim/contracts/servicenow';
import {
  Button,
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
import { ArrowDownLeft, ArrowUpRight, ExternalLink, FolderGit2, Mail, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApp, useApps, useIncidents } from '../api';
import {
  Eyebrow,
  GroupLink,
  Muted,
  refLinkClass,
  Section,
  TierBadge,
  TlaChip,
  UserLink,
} from '../components/bits';
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

const PAGE = 50;

export function AppList() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const query = useDebounced(q, 200);
  const { data, error, isLoading } = useApps({
    q: query || undefined,
    tier: tier ? (Number(tier) as AppTier) : undefined,
    limit,
  });
  const { sorted, head } = useClientSort(
    data?.items,
    {
      tla: (a) => a.tla,
      name: (a) => a.name,
      tier: (a) => a.tier,
      criticality: (a) => a.criticality,
      unit: (a) => a.business_unit,
      group: (a) => a.support_group.name,
    },
    'tla',
  );

  const crumbs: Crumb[] = [
    {
      label: 'All',
      onClick: () => {
        setTier('');
        setQ('');
      },
    },
  ];
  if (tier) crumbs.push({ label: `Tier = ${tier}`, onClick: () => setQ('') });
  if (query) crumbs.push({ label: `Keywords = ${query}` });

  return (
    <Page>
      <ListFrame
        title="Business Applications"
        search={
          <ListSearch
            autoFocus
            value={q}
            onChange={(v) => {
              setQ(v);
              setLimit(PAGE);
            }}
            placeholder="Search TLA, name or description…"
            label="Search applications"
          />
        }
        crumbs={crumbs}
        toolbar={
          <>
            <span className="text-[13px] text-muted-foreground">Tier</span>
            <NativeSelect
              aria-label="Tier"
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              className="h-7 w-32 bg-card text-[13px]"
            >
              <option value="">All tiers</option>
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
            </NativeSelect>
            <span className="ml-auto text-[13px] text-muted-foreground">
              Each TLA matches its GitLab group (keybank/&lt;TLA&gt;00) and the app_tla log label.
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
          <EmptyState title="No applications match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={listHeaderRowClass}>
                <SortHead className="w-24" {...head('tla')}>
                  TLA
                </SortHead>
                <SortHead {...head('name')}>Name</SortHead>
                <SortHead className="w-24" {...head('tier')}>
                  Tier
                </SortHead>
                <SortHead {...head('criticality')}>Business criticality</SortHead>
                <SortHead {...head('unit')}>Business unit</SortHead>
                <SortHead {...head('group')}>Support group</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((a) => (
                <TableRow
                  key={a.tla}
                  onClick={() => navigate(`/apps/${a.tla}`)}
                  className={cn(listRowClass, 'cursor-pointer')}
                >
                  <TableCell>
                    <TlaChip app={a} />
                  </TableCell>
                  <TableCell>
                    <Link
                      to={`/apps/${a.tla}`}
                      onClick={(e) => e.stopPropagation()}
                      className={refLinkClass}
                    >
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <TierBadge tier={a.tier} />
                  </TableCell>
                  <TableCell>{a.criticality}</TableCell>
                  <TableCell>{a.business_unit}</TableCell>
                  <TableCell>
                    <GroupLink group={a.support_group} />
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

function AppChips({ apps, limit = 40 }: { apps: AppRef[]; limit?: number }) {
  const [all, setAll] = useState(false);
  if (apps.length === 0) return <Muted>None</Muted>;
  const shown = all ? apps : apps.slice(0, limit);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((a) => (
        <TlaChip key={a.tla} app={a} />
      ))}
      {apps.length > shown.length && (
        <Button variant="link" size="xs" className="h-6 text-link" onClick={() => setAll(true)}>
          Show all {apps.length}
        </Button>
      )}
    </div>
  );
}

export function AppDetail() {
  const { tla = '' } = useParams();
  const { data: app, error, isLoading } = useApp(tla.toUpperCase());
  const incidents = useIncidents({ app_tla: tla.toUpperCase(), active: true, limit: 50 });
  usePageTitle(`Business Application - ${tla.toUpperCase()}`);

  if (isLoading) return <Spinner label="Loading application" />;
  if (error || !app) {
    return (
      <Page>
        <ErrorState error={error ?? `Application ${tla} not found`} />
      </Page>
    );
  }
  const sg = app.support_group;

  return (
    <div>
      <FormHeader
        backTo="/apps"
        backLabel="Back to applications"
        recordType="Business Application"
        title={`${app.tla} · ${app.name}`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={app.gitlab_group_url} target="_blank" rel="noreferrer">
                <FolderGit2 data-icon="inline-start" />
                GitLab {app.tla}00
                <ExternalLink data-icon="inline-end" className="size-3 text-muted-foreground" />
              </a>
            </Button>
            <Button asChild size="sm">
              <Link to={`/incidents/new?app=${app.tla}`}>
                <Plus data-icon="inline-start" />
                Create Incident
              </Link>
            </Button>
          </>
        }
      />

      <Page>
        <FormBody className="grid gap-2.5">
          <FormColumns>
            <FormColumn>
              <FormField label="Name">{app.name}</FormField>
              <FormField label="Number (TLA)">
                <span className="font-mono">{app.tla}</span>
              </FormField>
              <FormField label="Tier">
                <TierBadge tier={app.tier} />
              </FormField>
              <FormField label="Business criticality">
                <StatusBadge tone={app.tier === 1 ? 'negative' : 'neutral'}>
                  {app.criticality}
                </StatusBadge>
              </FormField>
              <FormField label="Business unit">{app.business_unit}</FormField>
              <FormField label="Lifecycle">{app.lifecycle}</FormField>
              <FormField label="Owned by" href={`/users/${app.owner.username}`}>
                <UserLink user={app.owner} />
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="Support group" href={`/groups/${sg.id}`}>
                <GroupLink group={sg} />
              </FormField>
              <FormField label="Technology stack">{app.stack}</FormField>
              <FormField label="Service">
                <span className="font-mono">{app.runtime.service}</span>
              </FormField>
              <FormField label="GCP project">
                <span className="font-mono">{app.runtime.gcp_project}</span>
              </FormField>
              <FormField label="Cluster / namespace">
                <span className="font-mono">
                  {app.runtime.cluster} / {app.runtime.namespace}
                </span>
              </FormField>
              <FormField label="Region">{app.runtime.region}</FormField>
              <FormField label="Open incidents">{app.open_incident_count}</FormField>
            </FormColumn>
          </FormColumns>
          <div className="mt-2">
            <FormField label="Description" multiline>
              {app.description}
            </FormField>
          </div>
        </FormBody>

        <Section
          title="Support group and on-call"
          actions={
            <Link to={`/groups/${sg.id}`} className={cn(refLinkClass, 'text-[13px]')}>
              {sg.name}
            </Link>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <a
              href={`mailto:${sg.email}`}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-link"
            >
              <Mail className="size-3.5" />
              {sg.email}
            </a>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <Eyebrow>Primary on call</Eyebrow>
              <ContactCard person={sg.on_call.primary} label="Primary" />
            </div>
            <div>
              <Eyebrow>Secondary on call</Eyebrow>
              <ContactCard person={sg.on_call.secondary} label="Secondary" />
            </div>
            <div>
              <Eyebrow>Manager</Eyebrow>
              <div className="rounded-(--radius) border p-3 text-[13px]">
                <UserLink user={sg.manager} avatar />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Dependencies" bodyClassName="grid gap-4">
          <div>
            <div className="mb-2 flex items-center gap-1.5 font-semibold text-[13px] text-muted-foreground">
              <ArrowUpRight className="size-3.5" /> Depends on (upstream) · {app.upstream.length}
            </div>
            <AppChips apps={app.upstream} />
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5 font-semibold text-[13px] text-muted-foreground">
              <ArrowDownLeft className="size-3.5" /> Used by (downstream) · {app.downstream.length}
            </div>
            <AppChips apps={app.downstream} />
          </div>
        </Section>

        <RelatedLists
          lists={[
            {
              id: 'incidents',
              label: 'Open Incidents',
              count: app.open_incident_count,
              content: incidents.data ? (
                <IncidentTable items={incidents.data.items} compact empty="No open incidents" />
              ) : (
                <Spinner />
              ),
            },
            {
              id: 'members',
              label: 'Support Group Members',
              count: sg.members.length,
              content: (
                <Table>
                  <TableHeader>
                    <TableRow className={listHeaderRowClass}>
                      <SortHead>Name</SortHead>
                      <SortHead>Title</SortHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sg.members.map((m) => (
                      <TableRow key={m.username} className={listRowClass}>
                        <TableCell>
                          <UserLink user={m} avatar />
                        </TableCell>
                        <TableCell className="w-full">{m.title}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ),
            },
            {
              id: 'repos',
              label: 'Repositories',
              count: app.repos.length,
              content: (
                <Table>
                  <TableHeader>
                    <TableRow className={listHeaderRowClass}>
                      <SortHead>Path</SortHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {app.repos.map((r) => (
                      <TableRow key={r.path} className={listRowClass}>
                        <TableCell>
                          <a
                            href={r.web_url}
                            target="_blank"
                            rel="noreferrer"
                            className={cn(refLinkClass, 'inline-flex items-center gap-2 font-mono')}
                          >
                            <FolderGit2 className="size-3.5 text-muted-foreground" />
                            {r.path}
                            <ExternalLink className="size-3" />
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ),
            },
          ]}
        />
      </Page>
    </div>
  );
}
