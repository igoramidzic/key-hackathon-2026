import { Button, cn, Tooltip, TooltipContent, TooltipTrigger, UserAvatar } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CircleHelp,
  ExternalLink,
  LayoutDashboard,
  ListTree,
  type LucideIcon,
  Settings,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { api, OPERATOR } from '../lib';
import { useBodyTheme, useFavicon } from './theme';

/** Moogsoft AIOps frame: dark navy top bar with the product nav, and a dark icon rail. */
export function MoogsoftShell() {
  useBodyTheme('theme-moogsoft');
  useFavicon('favicon-moogsoft.svg');
  const { pathname } = useLocation();
  const open = useQuery({
    queryKey: ['alerts', 'nav-count'],
    queryFn: () => api.listAlerts({ status: 'open', limit: 1 }),
    refetchInterval: 5_000,
  });
  const count = open.data?.total ?? 0;

  return (
    <div className="theme-moogsoft flex min-h-svh w-full min-w-0 flex-col text-[13px]">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-6 bg-(--moog-navy) pr-3 text-white shadow-[0_1px_0_rgba(255,255,255,0.06),0_2px_6px_rgba(0,0,0,0.25)]">
        <Link
          to="/alerts"
          className="flex h-full w-14 shrink-0 items-center justify-center bg-(--moog-navy-2)"
          aria-label="Moogsoft home"
        >
          <MoogMark />
        </Link>
        <Link to="/alerts" className="-ml-2 flex items-baseline gap-2">
          <Wordmark />
          <span className="hidden font-medium text-[11px] text-white/45 uppercase tracking-[0.14em] lg:inline">
            AIOps
          </span>
        </Link>

        <nav aria-label="Main" className="flex h-full items-stretch">
          <TopTab icon={ListTree}>Situations</TopTab>
          <TopTab icon={TriangleAlert} to="/alerts" active={pathname.startsWith('/alerts')}>
            Alerts
            {count > 0 && (
              <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-(--moog-critical) px-1 font-semibold text-[10px] text-white tabular-nums">
                {count}
              </span>
            )}
          </TopTab>
          <TopTab icon={LayoutDashboard}>Dashboards</TopTab>
          <TopTab icon={Workflow}>Workflows</TopTab>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <Link
            to="/logs"
            className="mr-2 inline-flex h-8 items-center gap-1.5 rounded-(--radius) border border-white/15 px-2.5 font-medium text-[12px] text-white/85 hover:border-(--moog-teal) hover:text-white"
          >
            <ExternalLink className="size-3.5 text-(--moog-teal)" />
            Open Logs Explorer
          </Link>
          <span
            title="This is a simulated Moogsoft console for incident drills"
            className="mr-1 hidden rounded-(--radius) border border-white/15 border-dashed px-1.5 py-0.5 text-[10px] text-white/50 uppercase tracking-wider lg:inline"
          >
            Simulated
          </span>
          <RailIcon label="Notifications" icon={Bell} />
          <RailIcon label="Settings" icon={Settings} />
          <RailIcon label="Help" icon={CircleHelp} />
          <span className="ml-1.5 inline-flex items-center gap-2">
            <UserAvatar name={OPERATOR.name} size="sm" className="ring-2 ring-(--moog-teal)/60" />
            <span className="hidden text-[12px] text-white/80 xl:inline">{OPERATOR.username}</span>
          </span>
        </div>
      </header>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/** "moogsoft" set in text, the "oo" picked out in the brand teal. */
function Wordmark() {
  return (
    <span className="font-bold text-[21px] lowercase leading-none tracking-[-0.03em]">
      m<span className="text-(--moog-teal)">oo</span>gsoft
    </span>
  );
}

/** A simple stand-in mark (not the real logo): two teal rings. */
function MoogMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
      <circle cx="8" cy="12" r="5" fill="none" stroke="var(--moog-teal)" strokeWidth="2.5" />
      <circle cx="16" cy="12" r="5" fill="none" stroke="#fff" strokeWidth="2.5" />
    </svg>
  );
}

function TopTab({
  icon: Icon,
  to,
  active,
  children,
}: {
  icon: LucideIcon;
  to?: string;
  active?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    'relative inline-flex items-center gap-2 px-3.5 font-semibold text-[13px] transition-colors',
    active
      ? 'bg-white/[0.07] text-white after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-(--moog-teal)'
      : 'text-white/60 hover:bg-white/[0.04] hover:text-white',
  );
  const icon = <Icon className={cn('size-4', active ? 'text-(--moog-teal)' : 'text-white/50')} />;
  if (!to) {
    return (
      <button type="button" className={cn(className, 'cursor-default')}>
        {icon}
        {children}
      </button>
    );
  }
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} className={className}>
      {icon}
      {children}
    </Link>
  );
}

function RailIcon({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-8 text-white/65 hover:bg-white/10 hover:text-white"
        >
          <Icon className="size-[18px]" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
