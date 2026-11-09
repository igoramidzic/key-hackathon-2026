import {
  type AppRef,
  type AppTier,
  type GroupRef,
  type IncidentState,
  PRIORITY_LABELS,
  type Priority,
  STATE_LABELS,
  type UserRef,
} from '@sim/contracts/servicenow';
import { cn, StatusBadge, StatusDot, type Tone, UserAvatar } from '@sim/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export const PRIORITY_TONES: Record<Priority, Tone> = {
  1: 'negative',
  2: 'warning',
  3: 'info',
  4: 'neutral',
  5: 'neutral',
};

/** ServiceNow shows priority as its choice label ("1 - Critical") behind a colored indicator. */
export function PriorityBadge({ priority, long = true }: { priority: Priority; long?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        priority === 1 && 'font-semibold',
      )}
    >
      <StatusDot tone={PRIORITY_TONES[priority]} className="size-2 rounded-full" />
      {long ? PRIORITY_LABELS[priority] : `P${priority}`}
    </span>
  );
}

const STATE_TONES: Record<IncidentState, Tone> = {
  new: 'info',
  in_progress: 'positive',
  on_hold: 'warning',
  resolved: 'neutral',
  closed: 'neutral',
  canceled: 'neutral',
};

/** State as plain choice text, the way list and form fields render it. */
export function StateBadge({ state }: { state: IncidentState }) {
  const done = state === 'resolved' || state === 'closed' || state === 'canceled';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        done && 'text-muted-foreground',
      )}
    >
      <StatusDot tone={STATE_TONES[state]} className="size-1.5 rounded-full" />
      {STATE_LABELS[state]}
    </span>
  );
}

export function TierBadge({ tier }: { tier: AppTier }) {
  return (
    <StatusBadge tone={tier === 1 ? 'negative' : tier === 2 ? 'warning' : 'neutral'}>
      Tier {tier}
    </StatusBadge>
  );
}

/** Blue reference link, the way ServiceNow renders reference fields in lists and forms. */
export const refLinkClass =
  'text-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none';

/** Monospace TLA chip that links to the application record. */
export function TlaChip({
  app,
  showName,
  className,
}: {
  app: Pick<AppRef, 'tla'> & Partial<Pick<AppRef, 'name' | 'tier'>>;
  showName?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={`/apps/${app.tla}`}
      title={app.name}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 whitespace-nowrap rounded-(--radius) border bg-card px-2 text-[13px] transition-colors hover:border-link/50 hover:bg-accent',
        className,
      )}
    >
      <span className="font-mono font-semibold text-link">{app.tla}</span>
      {app.tier === 1 && <StatusDot tone="negative" className="size-1.5 rounded-full" />}
      {showName && app.name && <span className="truncate text-foreground">{app.name}</span>}
    </Link>
  );
}

export function UserLink({ user, avatar = false }: { user: UserRef | null; avatar?: boolean }) {
  if (!user) return <Muted>—</Muted>;
  if (!user.web_url) return <span className="text-muted-foreground">{user.name}</span>;
  return (
    <Link
      to={`/users/${user.username}`}
      onClick={(e) => e.stopPropagation()}
      className={cn('inline-flex min-w-0 items-center gap-1.5', refLinkClass)}
    >
      {avatar && <UserAvatar name={user.name} size="xs" />}
      <span className="truncate">{user.name}</span>
    </Link>
  );
}

export function GroupLink({ group }: { group: GroupRef | null }) {
  if (!group) return <Muted>—</Muted>;
  return (
    <Link to={`/groups/${group.id}`} onClick={(e) => e.stopPropagation()} className={refLinkClass}>
      {group.name}
    </Link>
  );
}

/** A white form section with a ruled header, as on ServiceNow forms and related lists. */
export function Section({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-(--radius) border bg-card', className)}>
      <header className="flex min-h-10 items-center justify-between gap-3 border-b px-4 py-2">
        <h2 className="font-semibold text-[15px] text-foreground">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Small label inside a section, e.g. "On call". */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 font-semibold text-[13px] text-muted-foreground', className)}>
      {children}
    </div>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
