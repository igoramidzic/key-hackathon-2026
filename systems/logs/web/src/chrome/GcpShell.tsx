import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SystemLogo,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
} from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  EllipsisVertical,
  FileSearch,
  Hexagon,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  Menu,
  ScrollText,
  Search,
  Siren,
  Sparkles,
  Split,
  SquareTerminal,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { api, OPERATOR } from '../lib';
import { useBodyTheme, useFavicon } from './theme';

const PROJECT = { name: 'kb-prod', id: 'kb-prod-4417', org: 'keybank.com' };

/** Google Cloud console frame: white top bar, product nav on the left. */
export function GcpShell() {
  useBodyTheme('theme-gcp');
  useFavicon('favicon.svg');
  const [navOpen, setNavOpen] = useState(true);
  return (
    <div className="theme-gcp flex min-h-svh w-full min-w-0 flex-col">
      <GcpTopBar onToggleNav={() => setNavOpen((o) => !o)} />
      <div className="flex min-h-0 flex-1">
        {navOpen && (
          <aside className="sticky top-12 hidden h-[calc(100svh-3rem)] w-64 shrink-0 overflow-y-auto border-r bg-background md:block">
            <LoggingNav />
          </aside>
        )}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function IconAction({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-9 rounded-full text-muted-foreground hover:bg-muted"
        >
          <Icon className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function GcpTopBar({ onToggleNav }: { onToggleNav: () => void }) {
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the console search, as in the real console.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== '/' || target.closest('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-1 border-b bg-background pr-3 pl-1.5">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Main menu"
        onClick={onToggleNav}
        className="size-10 rounded-full text-muted-foreground hover:bg-muted"
      >
        <Menu className="size-5" />
      </Button>
      <Link
        to="/logs"
        className="mr-3 flex shrink-0 items-center gap-2 rounded-(--radius) px-1 py-1 hover:bg-muted"
      >
        <SystemLogo system="logs" className="size-7" />
        <span className="font-normal text-[19px] text-muted-foreground tracking-[-0.01em]">
          <span className="font-medium">Google</span> Cloud
        </span>
      </Link>

      <ProjectPicker />

      <form
        role="search"
        onSubmit={(e) => e.preventDefault()}
        className="mx-3 hidden h-9 max-w-[720px] flex-1 items-center rounded-[8px] border bg-background focus-within:border-primary focus-within:shadow-[0_1px_3px_rgba(60,64,67,0.25)] md:flex"
      >
        <Search className="ml-3 size-5 shrink-0 text-muted-foreground" />
        <input
          ref={searchRef}
          aria-label="Search resources, docs, products"
          placeholder="Search (/) for resources, docs, products, and more"
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          className="mr-1 inline-flex h-7 items-center gap-1 rounded-(--radius) px-3 font-medium text-[14px] text-primary hover:bg-accent"
        >
          <Search className="size-4" />
          Search
        </button>
      </form>

      <div className="ml-auto flex items-center gap-0.5">
        <span
          title="This is a simulated Google Cloud console for incident drills"
          className="mr-2 hidden rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground lg:inline"
        >
          Simulated
        </span>
        <IconAction label="Gemini" icon={Sparkles} />
        <IconAction label="Activate Cloud Shell" icon={SquareTerminal} />
        <IconAction label="Notifications" icon={Bell} />
        <IconAction label="Help for Logs Explorer" icon={CircleHelp} />
        <IconAction label="Settings and utilities" icon={EllipsisVertical} />
        <span className="ml-1.5 inline-flex rounded-full p-0.5 hover:bg-muted">
          <UserAvatar name={OPERATOR.name} size="md" />
        </span>
      </div>
    </header>
  );
}

function ProjectPicker() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-(--radius) border px-3 text-[14px] text-foreground hover:bg-muted aria-expanded:bg-muted"
        >
          <Hexagon className="size-4 text-muted-foreground" />
          {PROJECT.name}
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1">
        <DropdownMenuLabel className="text-[12px] text-muted-foreground">
          {PROJECT.org}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-3 py-2 text-[14px]">
          <Check className="size-4 text-primary" />
          <span className="grid">
            <span>{PROJECT.name}</span>
            <span className="text-[12px] text-muted-foreground">ID: {PROJECT.id}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LOGGING_NAV: { label: string; icon: LucideIcon; to?: string }[] = [
  { label: 'Logs Explorer', icon: FileSearch, to: '/logs' },
  { label: 'Log Analytics', icon: BarChart3 },
  { label: 'Logs Dashboard', icon: LayoutDashboard },
  { label: 'Log-based Metrics', icon: LineChart },
  { label: 'Log Router', icon: Split },
  { label: 'Logs Storage', icon: Database },
];

function LoggingNav() {
  const { pathname } = useLocation();
  const open = useQuery({
    queryKey: ['alerts', 'nav-count'],
    queryFn: () => api.listAlerts({ status: 'open', limit: 1 }),
    refetchInterval: 5_000,
  });
  const count = open.data?.total ?? 0;

  return (
    <nav aria-label="Logging" className="flex flex-col py-2 pr-3 text-[14px]">
      <div className="mb-1 flex h-12 items-center gap-3 pl-6">
        <ScrollText className="size-5 text-primary" />
        <span className="font-medium text-[16px] text-foreground">Logging</span>
      </div>
      {LOGGING_NAV.map((item) => (
        <NavItem
          key={item.label}
          icon={item.icon}
          to={item.to}
          active={Boolean(item.to && pathname.startsWith(item.to))}
        >
          {item.label}
        </NavItem>
      ))}
      <div className="my-2 ml-6 border-t" />
      <div className="px-6 pt-1 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
        Alerting
      </div>
      <NavItem icon={Siren} to="/alerts" active={pathname.startsWith('/alerts')}>
        <span className="flex-1">Moogsoft alerts</span>
        {count > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-negative px-1.5 font-medium text-[11px] text-white tabular-nums">
            {count}
          </span>
        )}
      </NavItem>
    </nav>
  );
}

function NavItem({
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
    'flex h-8 items-center gap-4 rounded-r-full pr-3 pl-6 text-left transition-colors',
    active ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground hover:bg-muted',
  );
  const icon = (
    <Icon
      className={cn(
        'size-[18px] shrink-0',
        active ? 'text-accent-foreground' : 'text-muted-foreground',
      )}
    />
  );
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
