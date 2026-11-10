import {
  CATEGORY_LABELS,
  CLOSE_CODES,
  type CloseCode,
  CONTACT_TYPE_LABELS,
  IMPACT_LABELS,
  type Incident,
  type IncidentCategory,
  type IncidentLink,
  type IncidentState,
  isActiveState,
  type LinkType,
  STATE_LABELS,
} from '@sim/contracts/servicenow';
import {
  Button,
  ErrorState,
  formatDateTime,
  NativeSelect,
  RelativeTime,
  Spinner,
  Textarea,
} from '@sim/ui';
import {
  Bell,
  CircleCheck,
  CornerDownRight,
  ExternalLink,
  GitMerge,
  Link2,
  Loader2,
  type LucideIcon,
  MessagesSquare,
  ScrollText,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { CURRENT_USER, useIncident, useUpdateIncident } from '../api';
import { ActivityStream } from '../components/Activity';
import {
  GroupLink,
  Muted,
  PriorityBadge,
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

const LINK_ICONS: Record<LinkType, LucideIcon> = {
  teams_channel: MessagesSquare,
  merge_request: GitMerge,
  alert: Bell,
  log_query: ScrollText,
  other: Link2,
};

function RelatedLink({ link }: { link: IncidentLink }) {
  const Icon = LINK_ICONS[link.type] ?? Link2;
  return (
    <li className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        title={link.url}
        className={`${refLinkClass} inline-flex min-w-0 items-center gap-1`}
      >
        <span className="truncate">{link.title}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
      </a>
      <span className="truncate text-muted-foreground text-xs">
        added by {link.added_by.name} · {formatDateTime(link.added_at)}
      </span>
    </li>
  );
}

const SETTABLE_STATES: IncidentState[] = ['new', 'in_progress', 'on_hold', 'canceled'];

/** The State field: an editable choice list that saves on change. */
function StateField({ incident }: { incident: Incident }) {
  const update = useUpdateIncident(incident.number);
  const terminal = incident.state === 'closed' || incident.state === 'canceled';
  if (terminal) return <FormField label="State">{STATE_LABELS[incident.state]}</FormField>;
  const options =
    incident.state === 'resolved'
      ? [...SETTABLE_STATES, 'resolved' as const, 'closed' as const]
      : SETTABLE_STATES;
  return (
    <FormField label="State" htmlFor="incident-state" editable>
      <div className="flex items-center gap-2">
        <NativeSelect
          id="incident-state"
          value={incident.state}
          onChange={(e) => update.mutate({ state: e.target.value as IncidentState })}
          className={`${fieldInputClass} w-full`}
        >
          {!options.includes(incident.state) && (
            <option value={incident.state}>{STATE_LABELS[incident.state]}</option>
          )}
          {options.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        {update.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {update.error && <div className="mt-1 text-destructive text-xs">{update.error.message}</div>}
    </FormField>
  );
}

/** The form header's UI actions. */
function Actions({ incident, onResolve }: { incident: Incident; onResolve: () => void }) {
  const update = useUpdateIncident(incident.number);
  const active = isActiveState(incident.state);
  const mine = incident.assigned_to?.username === CURRENT_USER;
  const assigning = update.isPending && update.variables?.assigned_to === CURRENT_USER;

  return (
    <>
      {update.error && (
        <span className="max-w-xs text-destructive text-xs">{update.error.message}</span>
      )}
      {active && !mine && (
        <Button
          size="sm"
          variant="outline"
          disabled={assigning}
          onClick={() =>
            update.mutate({
              assigned_to: CURRENT_USER,
              ...(incident.state === 'new' ? { state: 'in_progress' as const } : {}),
            })
          }
        >
          {assigning ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <UserCheck data-icon="inline-start" />
          )}
          Assign to me
        </Button>
      )}
      {active && (
        <Button size="sm" onClick={onResolve}>
          <CircleCheck data-icon="inline-start" />
          Resolve
        </Button>
      )}
    </>
  );
}

function ResolvePanel({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const update = useUpdateIncident(incident.number);
  const [code, setCode] = useState<CloseCode>('Solution provided');
  const [notes, setNotes] = useState('');
  return (
    <Section
      title="Resolution Information"
      className="border-primary/50 shadow-[inset_0_3px_0_var(--primary)]"
      bodyClassName="grid gap-2.5"
    >
      <FormColumns>
        <FormColumn>
          <FormField label="Resolution code" htmlFor="close-code" mandatory="filled" editable>
            <NativeSelect
              id="close-code"
              value={code}
              onChange={(e) => setCode(e.target.value as CloseCode)}
              className={`${fieldInputClass} w-full`}
            >
              {CLOSE_CODES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </NativeSelect>
          </FormField>
        </FormColumn>
      </FormColumns>
      <FormField
        label="Resolution notes"
        htmlFor="close-notes"
        mandatory={notes.trim() ? 'filled' : 'empty'}
        editable
        multiline
      >
        <Textarea
          id="close-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Root cause and fix, e.g. Reverted MR !42 in keybank/PAY00/payments-api."
          className="bg-card text-[13px] md:text-[13px]"
        />
      </FormField>
      <div className="flex items-center justify-end gap-2 pt-1">
        {update.error && (
          <span className="mr-auto text-destructive text-xs">{update.error.message}</span>
        )}
        <Button size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!notes.trim() || update.isPending}
          onClick={() =>
            update.mutate(
              { state: 'resolved', close_code: code, close_notes: notes },
              { onSuccess: onClose },
            )
          }
        >
          {update.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
          Resolve Incident
        </Button>
      </div>
    </Section>
  );
}

export function IncidentDetail() {
  const { number = '' } = useParams();
  const { data: incident, error, isLoading } = useIncident(number);
  const [resolving, setResolving] = useState(false);
  usePageTitle(`Incident - ${number}`);

  if (isLoading) return <Spinner label="Loading incident" />;
  if (error || !incident) {
    return (
      <Page>
        <ErrorState error={error ?? `Incident ${number} not found`} />
      </Page>
    );
  }
  const i = incident;
  const category = CATEGORY_LABELS[i.category as IncidentCategory] ?? i.category;

  return (
    <div>
      <FormHeader
        backTo="/incidents"
        backLabel="Back to incidents"
        recordType="Incident"
        title={
          <span title={i.short_description}>
            {i.number} · {i.short_description}
          </span>
        }
        actions={<Actions incident={i} onResolve={() => setResolving(true)} />}
      />

      <Page>
        {resolving && isActiveState(i.state) && (
          <ResolvePanel incident={i} onClose={() => setResolving(false)} />
        )}

        {i.parent_incident && (
          <div className="flex items-center gap-2 rounded-(--radius) border border-link/30 bg-accent px-4 py-2.5 text-[13px]">
            <CornerDownRight className="size-4 shrink-0 text-link" aria-hidden="true" />
            <span>
              Child of{' '}
              <Link to={`/incidents/${i.parent_incident}`} className={refLinkClass}>
                {i.parent_incident}
              </Link>
              . Comments on the parent are copied here, and resolving the parent resolves this
              incident.
            </span>
          </div>
        )}

        <FormBody className="grid gap-2.5">
          <FormColumns>
            <FormColumn>
              <FormField label="Number">{i.number}</FormField>
              <FormField
                label="Caller"
                mandatory="filled"
                href={i.caller?.web_url ? `/users/${i.caller.username}` : undefined}
              >
                <UserLink user={i.caller} />
              </FormField>
              <FormField label="Category">{category}</FormField>
              <FormField label="Subcategory">
                {i.subcategory ?? <Muted>-- None --</Muted>}
              </FormField>
              <FormField label="Configuration item" href={i.app ? `/apps/${i.app.tla}` : undefined}>
                {i.app ? <TlaChip app={i.app} showName className="h-5" /> : <Muted>—</Muted>}
              </FormField>
              <FormField
                label="Parent Incident"
                href={i.parent_incident ? `/incidents/${i.parent_incident}` : undefined}
              >
                {i.parent_incident ? (
                  <Link to={`/incidents/${i.parent_incident}`} className={refLinkClass}>
                    {i.parent_incident}
                  </Link>
                ) : (
                  <Muted>—</Muted>
                )}
              </FormField>
              <FormField label="Opened">
                {formatDateTime(i.opened_at)}
                <span className="ml-2 text-muted-foreground">
                  (<RelativeTime value={i.opened_at} />)
                </span>
              </FormField>
              <FormField
                label="Opened by"
                href={i.opened_by?.web_url ? `/users/${i.opened_by.username}` : undefined}
              >
                <UserLink user={i.opened_by} />
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="Channel">
                {CONTACT_TYPE_LABELS[i.contact_type] ?? i.contact_type}
              </FormField>
              <StateField incident={i} />
              <FormField label="Impact">{IMPACT_LABELS[i.impact]}</FormField>
              <FormField label="Urgency">{IMPACT_LABELS[i.urgency]}</FormField>
              <FormField label="Priority">
                <PriorityBadge priority={i.priority} />
              </FormField>
              <FormField
                label="Assignment group"
                href={i.assignment_group ? `/groups/${i.assignment_group.id}` : undefined}
              >
                <GroupLink group={i.assignment_group} />
              </FormField>
              <FormField
                label="Assigned to"
                href={i.assigned_to?.web_url ? `/users/${i.assigned_to.username}` : undefined}
              >
                <UserLink user={i.assigned_to} />
              </FormField>
            </FormColumn>
          </FormColumns>
          <div className="mt-2 grid gap-2.5">
            <FormField label="Short description" mandatory="filled" multiline>
              {i.short_description}
            </FormField>
            <FormField label="Description" multiline className="min-h-16">
              {i.description || <Muted>No description</Muted>}
            </FormField>
          </div>
        </FormBody>

        <Section title="Related Links">
          {i.links.length > 0 ? (
            <ul className="grid gap-2 text-[13px]">
              {i.links.map((l) => (
                <RelatedLink key={l.id} link={l} />
              ))}
            </ul>
          ) : (
            <Muted>No related links yet</Muted>
          )}
        </Section>

        {i.child_incidents.length > 0 && (
          <Section title={`Child Incidents (${i.child_incidents.length})`} bodyClassName="p-0">
            <IncidentTable items={i.child_incidents} compact />
          </Section>
        )}

        {(i.state === 'resolved' || i.state === 'closed' || i.close_notes) && (
          <Section title="Resolution Information" bodyClassName="grid gap-2.5">
            <FormColumns>
              <FormColumn>
                <FormField label="Resolution code">{i.close_code ?? <Muted>—</Muted>}</FormField>
                <FormField label="Resolved by">
                  <UserLink user={i.resolved_by} />
                </FormField>
              </FormColumn>
              <FormColumn>
                <FormField label="Resolved">
                  {i.resolved_at ? formatDateTime(i.resolved_at) : <Muted>—</Muted>}
                </FormField>
                <FormField label="Closed">
                  {i.closed_at ? formatDateTime(i.closed_at) : <Muted>—</Muted>}
                </FormField>
              </FormColumn>
            </FormColumns>
            <FormField label="Resolution notes" multiline>
              {i.close_notes ?? <Muted>—</Muted>}
            </FormField>
          </Section>
        )}

        <ActivityStream incident={i} />
      </Page>
    </div>
  );
}
