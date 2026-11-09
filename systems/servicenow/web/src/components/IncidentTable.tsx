import type { IncidentSort, IncidentSummary } from '@sim/contracts/servicenow';
import {
  cn,
  EmptyState,
  formatDateTime,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RelativeTime,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@sim/ui';
import { Info } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { GroupLink, PriorityBadge, refLinkClass, StateBadge, TlaChip, UserLink } from './bits';
import { listHeaderRowClass, listRowClass, SortHead } from './list';

const FRESH_MS = 120_000;

type SortField = 'number' | 'priority' | 'opened_at' | 'updated_at';

/** The list's record preview ("i") popover. */
function Preview({ i }: { i: IncidentSummary }) {
  return (
    <Popover>
      <PopoverTrigger
        onClick={(e) => e.stopPropagation()}
        aria-label={`Preview ${i.number}`}
        className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-border/60 hover:text-foreground"
      >
        <Info className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 p-0 text-[13px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b bg-list-header px-3 py-2 font-semibold">Incident {i.number}</div>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 p-3">
          <dt className="text-right text-muted-foreground">Short description</dt>
          <dd>{i.short_description}</dd>
          <dt className="text-right text-muted-foreground">Priority</dt>
          <dd>
            <PriorityBadge priority={i.priority} />
          </dd>
          <dt className="text-right text-muted-foreground">State</dt>
          <dd>
            <StateBadge state={i.state} />
          </dd>
          <dt className="text-right text-muted-foreground">Assigned to</dt>
          <dd>
            <UserLink user={i.assigned_to} />
          </dd>
          <dt className="text-right text-muted-foreground">Opened</dt>
          <dd>{formatDateTime(i.opened_at)}</dd>
        </dl>
        <div className="border-t px-3 py-2 text-right">
          <Link to={`/incidents/${i.number}`} className={refLinkClass}>
            Open Record
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function IncidentTable({
  items,
  compact,
  empty = 'No incidents',
  sort,
  onSort,
}: {
  items: IncidentSummary[];
  /** Hide the app and group columns (for app and group pages). */
  compact?: boolean;
  empty?: string;
  /** Server sort; omit to show static headers. */
  sort?: IncidentSort;
  onSort?: (sort: IncidentSort) => void;
}) {
  const navigate = useNavigate();
  if (items.length === 0) return <EmptyState title={empty} />;
  const now = Date.now();
  const field = sort?.replace(/^-/, '') as SortField | undefined;
  const dir = sort?.startsWith('-') ? 'desc' : 'asc';
  const head = (f: SortField) =>
    onSort
      ? {
          active: field === f,
          dir: dir as 'asc' | 'desc',
          onSort: () =>
            // Priority starts at 1 - Critical; number and dates start newest first.
            onSort(
              (field === f
                ? dir === 'asc'
                  ? `-${f}`
                  : f
                : f === 'priority'
                  ? f
                  : `-${f}`) as IncidentSort,
            ),
        }
      : {};
  return (
    <Table>
      <TableHeader>
        <TableRow className={listHeaderRowClass}>
          <SortHead className="w-9 px-0 first:pl-0">
            <span className="sr-only">Preview</span>
          </SortHead>
          <SortHead className="w-32" {...head('number')}>
            Number
          </SortHead>
          <SortHead className="w-32" {...head('priority')}>
            Priority
          </SortHead>
          <SortHead>Short description</SortHead>
          {!compact && <SortHead className="w-24">CI</SortHead>}
          <SortHead className="w-28">State</SortHead>
          {!compact && <SortHead>Assignment group</SortHead>}
          <SortHead>Assigned to</SortHead>
          <SortHead className="w-28" {...head('updated_at')}>
            Updated
          </SortHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => {
          const fresh = now - new Date(i.opened_at).getTime() < FRESH_MS;
          return (
            <TableRow
              key={i.number}
              onClick={() => navigate(`/incidents/${i.number}`)}
              className={cn(listRowClass, 'cursor-pointer', fresh && 'bg-accent even:bg-accent')}
            >
              <TableCell className="w-9 px-1.5">
                <Preview i={i} />
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <Link
                    to={`/incidents/${i.number}`}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(refLinkClass, 'font-medium')}
                  >
                    {i.number}
                  </Link>
                  {fresh && (
                    <span
                      className="size-1.5 animate-pulse rounded-full bg-link"
                      title="Opened in the last 2 minutes"
                    />
                  )}
                </span>
              </TableCell>
              <TableCell>
                <PriorityBadge priority={i.priority} />
              </TableCell>
              <TableCell className="w-full max-w-0 min-w-48">
                <div className="truncate" title={i.short_description}>
                  {i.short_description}
                </div>
              </TableCell>
              {!compact && <TableCell>{i.app ? <TlaChip app={i.app} /> : null}</TableCell>}
              <TableCell>
                <StateBadge state={i.state} />
              </TableCell>
              {!compact && (
                <TableCell>
                  <GroupLink group={i.assignment_group} />
                </TableCell>
              )}
              <TableCell>
                <UserLink user={i.assigned_to} />
              </TableCell>
              <TableCell className="text-muted-foreground" title={formatDateTime(i.updated_at)}>
                <RelativeTime value={i.updated_at} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
