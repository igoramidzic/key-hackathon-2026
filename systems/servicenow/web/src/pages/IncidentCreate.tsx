import {
  CATEGORY_LABELS,
  CONTACT_TYPE_LABELS,
  CONTACT_TYPES,
  type ContactType,
  IMPACT_LABELS,
  type ImpactUrgency,
  INCIDENT_CATEGORIES,
  priorityFor,
} from '@sim/contracts/servicenow';
import { Button, cn, Input, NativeSelect, Textarea, useDebounced } from '@sim/ui';
import { Loader2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CURRENT_USER, useApp, useCreateIncident, useGroup, useGroups, useUser } from '../api';
import { PriorityBadge, TierBadge } from '../components/bits';
import {
  FormBody,
  FormColumn,
  FormColumns,
  FormField,
  FormHeader,
  fieldInputClass,
} from '../components/form';
import { Page, usePageTitle } from '../components/Layout';

/** Helper text under an editable field. */
function Hint({ children }: { children: ReactNode }) {
  return <div className="mt-1 min-h-4 text-muted-foreground text-xs">{children}</div>;
}

const selectClass = cn(fieldInputClass, 'w-full');

const LEVELS: ImpactUrgency[] = [1, 2, 3];

export function IncidentCreate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const create = useCreateIncident();

  const [caller, setCaller] = useState(CURRENT_USER);
  const [contactType, setContactType] = useState<ContactType>('phone');
  const [category, setCategory] = useState('application');
  const [subcategory, setSubcategory] = useState('');
  const [tla, setTla] = useState((params.get('app') ?? '').toUpperCase());
  const [impact, setImpact] = useState<ImpactUrgency>(3);
  const [urgency, setUrgency] = useState<ImpactUrgency>(3);
  const [group, setGroup] = useState('');
  const [assignee, setAssignee] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');

  const debouncedTla = useDebounced(tla.trim(), 250);
  const app = useApp(debouncedTla.length >= 2 ? debouncedTla : undefined);
  const callerUser = useUser(useDebounced(caller.trim(), 300) || undefined);
  const groups = useGroups({ limit: 100 });
  const groupDetail = useGroup(group || undefined);

  usePageTitle('Incident - Create');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        short_description: shortDescription,
        description: description || undefined,
        caller: caller || undefined,
        opened_by: CURRENT_USER,
        contact_type: contactType,
        category,
        subcategory: subcategory || undefined,
        app_tla: tla || undefined,
        impact,
        urgency,
        assignment_group: group || undefined,
        assigned_to: assignee || undefined,
      },
      { onSuccess: (incident) => navigate(`/incidents/${incident.number}`) },
    );
  };

  const submitting = create.isPending;
  const canSubmit = !!shortDescription.trim() && !submitting;
  const submitButton = (
    <Button type="submit" size="sm" disabled={!canSubmit}>
      {submitting && <Loader2 className="animate-spin" data-icon="inline-start" />}
      Submit
    </Button>
  );

  return (
    <form onSubmit={submit}>
      <FormHeader
        backTo="/incidents"
        backLabel="Back to incidents"
        recordType="Incident"
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
                label="Caller"
                htmlFor="caller"
                mandatory={caller.trim() ? 'filled' : 'empty'}
                editable
              >
                <Input
                  id="caller"
                  value={caller}
                  onChange={(e) => setCaller(e.target.value)}
                  className={fieldInputClass}
                />
                <Hint>
                  {callerUser.data
                    ? `${callerUser.data.name} · ${callerUser.data.title}`
                    : 'Username, e.g. mlopez'}
                </Hint>
              </FormField>
              <FormField label="Category" htmlFor="category" editable>
                <NativeSelect
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className={selectClass}
                >
                  {INCIDENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Subcategory" htmlFor="subcategory" editable>
                <Input
                  id="subcategory"
                  value={subcategory}
                  onChange={(e) => setSubcategory(e.target.value)}
                  placeholder="-- None --"
                  className={fieldInputClass}
                />
              </FormField>
              <FormField label="Configuration item" htmlFor="tla" editable>
                <Input
                  id="tla"
                  value={tla}
                  onChange={(e) => setTla(e.target.value.toUpperCase())}
                  placeholder="Application TLA, e.g. TLR"
                  maxLength={5}
                  className={cn(fieldInputClass, 'font-mono')}
                />
                <Hint>
                  {app.data ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{app.data.name}</span>
                      <TierBadge tier={app.data.tier} />
                      {group !== app.data.support_group.id && (
                        <button
                          type="button"
                          className="text-link underline-offset-2 hover:underline"
                          onClick={() => {
                            setGroup(app.data.support_group.id);
                            setAssignee('');
                          }}
                        >
                          Assign to {app.data.support_group.name}
                        </button>
                      )}
                    </span>
                  ) : app.error && debouncedTla ? (
                    <span className="text-destructive">Unknown application {debouncedTla}</span>
                  ) : null}
                </Hint>
              </FormField>
            </FormColumn>
            <FormColumn>
              <FormField label="Channel" htmlFor="contact-type" editable>
                <NativeSelect
                  id="contact-type"
                  value={contactType}
                  onChange={(e) => setContactType(e.target.value as ContactType)}
                  className={selectClass}
                >
                  {CONTACT_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {CONTACT_TYPE_LABELS[c]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="State">New</FormField>
              <FormField label="Impact" htmlFor="impact" editable>
                <NativeSelect
                  id="impact"
                  value={impact}
                  onChange={(e) => setImpact(Number(e.target.value) as ImpactUrgency)}
                  className={selectClass}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {IMPACT_LABELS[l]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Urgency" htmlFor="urgency" editable>
                <NativeSelect
                  id="urgency"
                  value={urgency}
                  onChange={(e) => setUrgency(Number(e.target.value) as ImpactUrgency)}
                  className={selectClass}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {IMPACT_LABELS[l]}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Priority">
                <PriorityBadge priority={priorityFor(impact, urgency)} />
              </FormField>
              <FormField label="Assignment group" htmlFor="group" editable>
                <NativeSelect
                  id="group"
                  value={group}
                  onChange={(e) => {
                    setGroup(e.target.value);
                    setAssignee('');
                  }}
                  className={selectClass}
                >
                  <option value="">-- None --</option>
                  {groups.data?.items.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Assigned to" htmlFor="assignee" editable>
                <NativeSelect
                  id="assignee"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  disabled={!group}
                  className={selectClass}
                >
                  <option value="">-- None --</option>
                  {groupDetail.data?.members.map((m) => (
                    <option key={m.username} value={m.username}>
                      {m.name} · {m.title}
                    </option>
                  ))}
                </NativeSelect>
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
                placeholder="e.g. Teller application freezing at Cleveland Main Branch"
                className={fieldInputClass}
              />
            </FormField>
            <FormField label="Description" htmlFor="description" editable multiline>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                className="min-h-28 bg-card text-[13px] md:text-[13px]"
              />
            </FormField>
          </div>
          <p className="mt-1 text-muted-foreground text-xs sm:pl-[calc(10rem+0.75rem)]">
            Opened by Dana Whitfield (NOC). Priority is derived from impact and urgency.
          </p>
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
