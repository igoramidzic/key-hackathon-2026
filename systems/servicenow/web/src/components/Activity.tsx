import type { Incident, JournalEntry } from '@sim/contracts/servicenow';
import {
  Button,
  cn,
  formatDateTime,
  Kbd,
  KbdGroup,
  RelativeTime,
  Textarea,
  UserAvatar,
} from '@sim/ui';
import { Loader2, Settings2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useAddJournal } from '../api';
import { Section } from './bits';
import { FormField } from './form';

type NoteType = 'work_note' | 'comment';

/**
 * The journal composer: one field that posts a work note, or an additional comment when the
 * "Additional comments (Customer visible)" box is checked.
 */
function Composer({ number }: { number: string }) {
  const [type, setType] = useState<NoteType>('work_note');
  const [text, setText] = useState('');
  const add = useAddJournal(number);
  const id = useId();
  const post = () => add.mutate({ type, text }, { onSuccess: () => setText('') });
  const workNote = type === 'work_note';
  return (
    <div className="mb-6 grid gap-2">
      <FormField
        label={workNote ? 'Work notes' : 'Additional comments'}
        htmlFor={`${id}-text`}
        editable
        multiline
      >
        <Textarea
          id={`${id}-text`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) post();
          }}
          rows={3}
          placeholder={
            workNote ? 'Work notes (internal)' : 'Additional comments, visible to the caller'
          }
          className={cn(
            'min-h-20 text-[13px] md:text-[13px]',
            workNote ? 'border-l-4 border-l-work-note-accent bg-work-note' : 'bg-card',
          )}
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-3 sm:pl-[calc(10rem+0.75rem)]">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={!workNote}
            onChange={(e) => setType(e.target.checked ? 'comment' : 'work_note')}
            className="size-4 accent-primary"
          />
          Additional comments (Customer visible)
        </label>
        <span className="ml-auto flex items-center gap-3">
          {add.error && <span className="text-destructive text-xs">{add.error.message}</span>}
          <KbdGroup className="hidden text-muted-foreground sm:inline-flex">
            <Kbd>⌘</Kbd>
            <Kbd>Enter</Kbd>
          </KbdGroup>
          <Button size="sm" disabled={!text.trim() || add.isPending} onClick={post}>
            {add.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
            Post
          </Button>
        </span>
      </div>
    </div>
  );
}

const TYPE_LABEL: Record<JournalEntry['type'], string> = {
  work_note: 'Work notes',
  comment: 'Additional comments',
  system: 'Field changes',
};

function Entry({ entry }: { entry: JournalEntry }) {
  const system = entry.type === 'system';
  return (
    <li className="flex gap-3">
      {system ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
          <Settings2 className="size-4" />
        </span>
      ) : (
        <UserAvatar name={entry.author.name} />
      )}
      <div
        className={cn(
          'min-w-0 flex-1 rounded-(--radius) border bg-card',
          entry.type === 'work_note' && 'border-l-4 border-l-work-note-accent bg-work-note',
          entry.type === 'comment' && 'border-l-4 border-l-border',
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 pt-2 text-[13px]">
          <span className="font-semibold text-foreground">{entry.author.name}</span>
          <span className="text-muted-foreground">
            {TYPE_LABEL[entry.type]} •{' '}
            <span title={formatDateTime(entry.created_at)}>
              <RelativeTime value={entry.created_at} />
            </span>
          </span>
        </div>
        {system && entry.changes?.length ? (
          <table className="mx-3 mt-1.5 mb-2.5 w-[calc(100%-1.5rem)] text-[13px]">
            <tbody>
              {entry.changes.map((c, i) => (
                <tr key={i}>
                  <td className="w-40 py-0.5 pr-3 align-top text-muted-foreground">{c.label}</td>
                  <td className="py-0.5 text-foreground">
                    {c.field === 'description'
                      ? 'Updated'
                      : (c.to ?? <span className="text-muted-foreground">(empty)</span>)}
                    {c.from && c.field !== 'description' && (
                      <span className="ml-2 text-muted-foreground">was: {c.from}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div
            className={cn(
              'px-3 pt-1 pb-2.5 text-[13px]/relaxed whitespace-pre-wrap text-foreground',
              system && 'text-muted-foreground',
            )}
          >
            {entry.text}
          </div>
        )}
      </div>
    </li>
  );
}

export function ActivityStream({ incident }: { incident: Incident }) {
  const entries = [...incident.journal].reverse();
  return (
    <Section title="Notes">
      <Composer number={incident.number} />
      <div className="mb-3 flex items-center gap-2 border-b pb-2">
        <h3 className="font-semibold text-[14px] text-foreground">
          Activities: {incident.journal.length}
        </h3>
      </div>
      <ol className="space-y-3">
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </ol>
    </Section>
  );
}
