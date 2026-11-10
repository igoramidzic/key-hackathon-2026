import { URLS } from '@sim/contracts';
import { AlertTriangle, ArrowUpRight, Inbox, Loader2 } from 'lucide-react';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Alert, AlertDescription } from './components/alert';
import { Button } from './components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './components/empty';
import { LOGOS } from './logos.generated';

// ---------------------------------------------------------------------------
// App shell: full-width, sticky header, Finnear-style nav. No centered column.
// ---------------------------------------------------------------------------

export type SystemId = 'simulator' | 'logs' | 'servicenow' | 'gitlab' | 'teams';

export const SYSTEM_META: Record<SystemId, { name: string; tagline: string }> = {
  simulator: { name: 'Incident Simulator', tagline: 'Scenarios and control' },
  logs: { name: 'Cloud Logging', tagline: 'Logs Explorer and Moogsoft alerts' },
  servicenow: { name: 'ServiceNow', tagline: 'Incidents, CMDB and people' },
  gitlab: { name: 'GitLab', tagline: 'keybank groups, code and merge requests' },
  teams: { name: 'Microsoft Teams', tagline: 'Incident channels and activity' },
};

function LogoSvg({ logo, className }: { logo: keyof typeof LOGOS; className?: string }) {
  const { width, height, body } = LOGOS[logo];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className={cn('size-5 shrink-0', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static CC0 logo markup
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

/**
 * The product's logo. GitLab, Teams and Google Cloud use the real marks (svgporn logos, CC0);
 * ServiceNow isn't in any open logo set, so it gets its wordmark's green "o"; the simulator gets
 * a square mark.
 */
export function SystemLogo({ system, className }: { system: SystemId; className?: string }) {
  if (system === 'gitlab') return <LogoSvg logo="gitlab" className={className} />;
  if (system === 'teams') return <LogoSvg logo="teams" className={className} />;
  if (system === 'logs') return <LogoSvg logo="googleCloud" className={className} />;
  if (system === 'servicenow') {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-full border-[3.5px] border-[#62d84e]',
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center bg-primary font-mono text-[9px] font-semibold text-primary-foreground',
        className,
      )}
    >
      IS
    </span>
  );
}

/** @deprecated use SystemLogo. */
export const SystemMark = SystemLogo;

/** Raised and underlined for the current page; muted for the rest (Finnear's nav treatment). */
export const navLinkClass = (active: boolean) =>
  cn(
    active
      ? 'border-foreground/15 bg-muted text-foreground shadow-[inset_0_-2px_0_var(--foreground)]'
      : 'text-muted-foreground',
  );

const systemUrl = (id: SystemId) => (id === 'simulator' ? URLS.simulator.web : URLS[id].web);

/** The app header's title: logo and product name (ServiceNow as its lowercase wordmark). */
export function SystemSwitcher({ current }: { current: SystemId }) {
  if (current === 'servicenow') {
    return (
      <span className="flex shrink-0 items-center px-1.5 font-semibold text-[17px] text-foreground tracking-tight">
        service
        <span className="tracking-tight">n</span>
        <span
          aria-hidden="true"
          className="mx-[1px] inline-block size-[13px] translate-y-[1px] rounded-full border-[3px] border-[#62d84e]"
        />
        <span>w</span>
        <span className="sr-only">ServiceNow</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-2 px-1.5">
      <SystemLogo system={current} />
      <span className="font-semibold text-foreground text-sm">{SYSTEM_META[current].name}</span>
    </span>
  );
}

/**
 * Links from the simulator to the four systems it drives, with their logos. Each opens in a new
 * tab so the control panel stays put during a demo.
 */
export function SystemLinks({ className }: { className?: string }) {
  const systems: SystemId[] = ['logs', 'servicenow', 'gitlab', 'teams'];
  return (
    <nav
      aria-label="Simulated systems"
      className={cn('flex items-stretch gap-1 overflow-x-auto', className)}
    >
      {systems.map((id) => (
        <a
          key={id}
          href={systemUrl(id)}
          target="_blank"
          rel="noopener noreferrer"
          title={`${SYSTEM_META[id].tagline} (opens in a new tab)`}
          className="inline-flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-muted-foreground text-sm transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          <SystemLogo system={id} className="size-4" />
          {SYSTEM_META[id].name}
          <ArrowUpRight aria-hidden="true" className="-ml-1 size-2.5 opacity-60" />
        </a>
      ))}
    </nav>
  );
}

/**
 * The app frame: a sticky 48px header (product logo and name, nav, right-side actions; the
 * simulator also gets a tab strip linking the four systems unless `systemLinks` is false) over a
 * full-width page. Use `sidebar` for apps that need a persistent left pane (Teams channels,
 * GitLab project nav); it renders below the header at a fixed width.
 */
export function AppShell({
  system,
  nav,
  actions,
  sidebar,
  sidebarClassName,
  children,
  padded = true,
  systemLinks = true,
}: {
  system: SystemId;
  nav?: ReactNode;
  actions?: ReactNode;
  sidebar?: ReactNode;
  /** Overrides for the sidebar pane, e.g. its width (default w-64). */
  sidebarClassName?: string;
  children: ReactNode;
  /** Page padding (turn off for edge-to-edge panes like chat). */
  padded?: boolean;
  /** Simulator only: show the tab strip linking the four systems (default true). */
  systemLinks?: boolean;
}) {
  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col bg-background">
      <div className="sticky top-0 z-20">
        <header className="h-12 shrink-0 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <div className="flex h-full w-full items-center gap-1 px-3 sm:gap-2 md:px-4">
            <SystemSwitcher current={system} />
            {nav && (
              <nav aria-label="Main" className="ml-2 hidden items-center gap-1 md:flex">
                {nav}
              </nav>
            )}
            <div className="ml-auto flex items-center gap-2">
              {actions}
              {system !== 'simulator' && (
                <span className="hidden border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider lg:inline">
                  Simulated
                </span>
              )}
            </div>
          </div>
        </header>
        {system === 'simulator' && systemLinks && (
          <SystemLinks className="h-10 border-b bg-background/90 px-2 backdrop-blur md:px-3" />
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <aside
            className={cn(
              'sticky top-12 hidden h-[calc(100svh-3rem)] w-64 shrink-0 overflow-y-auto overflow-x-hidden border-r bg-card md:block',
              sidebarClassName,
            )}
          >
            {sidebar}
          </aside>
        )}
        <main className={cn('min-w-0 flex-1', padded && 'px-4 py-5 md:px-6 md:py-6')}>
          {children}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small line above the title, e.g. breadcrumbs or a record type. */
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className="grid min-w-0 gap-1">
        {eyebrow && <div className="text-muted-foreground text-xs">{eyebrow}</div>}
        <h1 className="truncate font-semibold text-xl tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Label/value grid for record details. */
export function KeyValue({
  items,
  columns = 2,
}: {
  items: { label: string; value: ReactNode }[];
  columns?: 1 | 2 | 3 | 4;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-3',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-3',
        columns === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className="mt-0.5 break-words text-xs text-foreground">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A number with a label, for summary rows of cards. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="grid gap-1">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn('font-semibold text-xl tabular-nums tracking-tight', tone && toneText[tone])}
      >
        {value}
      </div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Semantic tones. Color is reserved for status and data, never decoration. */
export type Tone = 'neutral' | 'negative' | 'warning' | 'positive' | 'info' | 'accent';

const toneText: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  negative: 'text-negative',
  warning: 'text-warning',
  positive: 'text-positive',
  info: 'text-chart-1',
  accent: 'text-chart-4',
};

const toneBadge: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  negative: 'bg-negative/10 text-negative',
  warning: 'bg-warning/10 text-warning',
  positive: 'bg-positive/10 text-positive',
  info: 'bg-chart-1/10 text-chart-1',
  accent: 'bg-chart-4/10 text-chart-4',
};

const toneDot: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  negative: 'bg-negative',
  warning: 'bg-warning',
  positive: 'bg-positive',
  info: 'bg-chart-1',
  accent: 'bg-chart-4',
};

/** Square status chip: tinted background, colored text, optional dot. */
export function StatusBadge({
  tone = 'neutral',
  dot,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-(--radius) px-1.5 font-medium text-xs whitespace-nowrap',
        toneBadge[tone],
        className,
      )}
    >
      {dot && <span className={cn('size-1.5', toneDot[tone])} />}
      {children}
    </span>
  );
}

/** Square status dot (health indicators, presence). */
export function StatusDot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0', toneDot[tone], className)} />;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <div
      className={cn('flex items-center justify-center gap-2 p-8 text-muted-foreground', className)}
    >
      <Loader2 className="size-4 animate-spin" />
      {label && <span className="text-xs">{label}</span>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Inbox />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  );
}

/** "Load more" footer for cursor-paginated lists. */
export function LoadMore({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center p-3">
      <Button size="sm" variant="ghost" disabled={loading} onClick={onClick}>
        {loading && <Loader2 className="animate-spin" data-icon="inline-start" />}
        Load more
      </Button>
    </div>
  );
}

/** Plain native <select> in the input style, for simple filters (use Select for rich menus). */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 min-w-0 rounded-(--radius) border border-input bg-transparent px-2.5 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
