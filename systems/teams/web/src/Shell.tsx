import type { TeamsUser } from '@sim/contracts/teams';
import {
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SystemLogo,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useDebounced,
} from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  Calendar,
  Check,
  Hash,
  type LucideIcon,
  MessageSquare,
  Phone,
  Search,
  Siren,
  UsersRound,
} from 'lucide-react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, keys, useAllChannels, useNotifications, useUser } from './api';
import { presenceLabel } from './format';
import { PersonAvatar } from './people';
import { TeamsPane } from './TeamsPane';
import { useViewer } from './viewer';

/**
 * Teams' frame: a gray title bar (logo, search, the person you're viewing as), the app bar down
 * the left, then the list pane and the content area on a rounded sheet.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const onActivity = pathname.startsWith('/activity');
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-svh w-full min-w-0 flex-col overflow-hidden bg-chrome text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <AppBar />
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[8px] border-t border-l bg-background">
            {!onActivity && (
              <aside
                aria-label="Teams and channels"
                className="hidden w-[320px] shrink-0 overflow-y-auto border-r bg-pane md:block"
              >
                <TeamsPane />
              </aside>
            )}
            <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------

function TitleBar() {
  return (
    <header className="grid h-12 shrink-0 grid-cols-[1fr_minmax(0,560px)_1fr] items-center gap-3 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <SystemLogo system="teams" className="size-6" />
        <span className="hidden truncate font-semibold text-[14px] text-foreground sm:inline">
          Microsoft Teams
        </span>
      </div>
      <SearchBox />
      <div className="flex min-w-0 items-center justify-end gap-2">
        <span
          title="This is a simulated Microsoft Teams for incident demos"
          className="hidden h-5 items-center rounded-full border border-[#d1d1d1] bg-card/60 px-2 text-[11px] text-muted-foreground lg:inline-flex"
        >
          Simulated
        </span>
        <ViewerSwitcher />
      </div>
    </header>
  );
}

/** Searches channels (name, display name, description) and jumps to the one you pick. */
function SearchBox() {
  const channels = useAllChannels();
  const { link } = useViewer();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return (channels.data?.items ?? [])
      .filter((c) =>
        [
          c.name,
          ...c.previous_names,
          c.display_name,
          c.description,
          c.team_name,
          c.incident_number ?? '',
        ].some((v) => v.toLowerCase().includes(needle)),
      )
      .slice(0, 8);
  }, [q, channels.data]);

  const go = (id: string) => {
    navigate(link(`/channels/${id}`));
    setQ('');
    inputRef.current?.blur();
  };

  return (
    <div className="relative min-w-0">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && results[active]) {
            go(results[active].id);
          } else if (e.key === 'Escape') {
            setQ('');
            e.currentTarget.blur();
          }
        }}
        placeholder="Search"
        aria-label="Search channels"
        className="h-8 w-full rounded-[4px] border border-transparent bg-card pr-3 pl-8 text-[14px] outline-none transition-colors placeholder:text-muted-foreground hover:border-[#c7c7c7] focus:border-transparent focus:shadow-[inset_0_-2px_0_var(--primary)]"
      />
      {focused && q.trim() && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[6px] bg-popover py-1 shadow-fluent-8">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-[13px] text-muted-foreground">
              No channels match “{q.trim()}”.
            </div>
          ) : (
            <>
              <div className="px-3 pt-1 pb-1 font-semibold text-[12px] text-muted-foreground">
                Channels
              </div>
              {results.map((c, i) => (
                <button
                  type="button"
                  key={c.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(c.id);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
                    i === active && 'bg-accent',
                  )}
                >
                  {c.incident_number ? (
                    <Siren className="size-4 shrink-0 text-negative" />
                  ) : (
                    <Hash className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{c.display_name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {c.team_name}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ViewerSwitcher() {
  const { username, setViewer } = useViewer();
  const me = useUser(username);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 150);
  const users = useQuery({
    queryKey: keys.users(debounced),
    queryFn: () => api.listUsers({ q: debounced, limit: 12 }),
    enabled: open,
    staleTime: 30_000,
  });
  const [active, setActive] = useState(0);

  const choose = (user: TeamsUser) => {
    setViewer(user.username);
    setOpen(false);
    setQ('');
  };
  const items = users.data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Viewing as (switch person)"
          className="flex h-9 min-w-0 items-center gap-2 rounded-[4px] px-1.5 outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-black/5"
        >
          <span className="hidden min-w-0 text-right leading-tight sm:block">
            <span className="block text-[10px] text-muted-foreground">Viewing as</span>
            <span className="block truncate font-semibold text-[12px] text-foreground">
              {me.data?.name ?? username}
            </span>
          </span>
          <PersonAvatar
            name={me.data?.name ?? username}
            username={username}
            presence={me.data?.presence}
            size="md"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] gap-0 rounded-[8px] p-0 shadow-fluent-8">
        {me.data && (
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <PersonAvatar
              name={me.data.name}
              username={me.data.username}
              presence={me.data.presence}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-[14px]">{me.data.name}</div>
              <div className="truncate text-[12px] text-muted-foreground">{me.data.title}</div>
              <div className="text-[12px] text-muted-foreground">
                {presenceLabel(me.data.presence)} · member of {me.data.channels.length} channel
                {me.data.channels.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>
        )}
        <div className="relative p-2">
          <Search className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && items[active]) {
                choose(items[active]);
              }
            }}
            placeholder="Switch person: name, username or email"
            className="pl-7"
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto pb-1">
          {!debounced && (
            <div className="px-4 pt-1 pb-1 font-semibold text-[12px] text-muted-foreground">
              Demo personas
            </div>
          )}
          {items.map((user, i) => (
            <button
              type="button"
              key={user.username}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(user)}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2 text-left outline-none',
                i === active && 'bg-accent',
              )}
            >
              <PersonAvatar
                name={user.name}
                username={user.username}
                presence={user.presence}
                size="md"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">{user.name}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {user.title} · {user.username}
                </span>
              </span>
              {user.username === username && <Check className="size-4 text-primary" />}
            </button>
          ))}
          {users.isSuccess && items.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">
              No people match.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// App bar
// ---------------------------------------------------------------------------

function AppBar() {
  const { username, link } = useViewer();
  const notifications = useNotifications(username);
  const unread = notifications.data?.unread_count ?? 0;
  const { pathname } = useLocation();
  const onActivity = pathname.startsWith('/activity');
  return (
    <nav aria-label="Apps" className="flex w-[68px] shrink-0 flex-col items-center gap-0.5 pt-1">
      <AppBarItem
        to={link('/activity')}
        icon={Bell}
        label="Activity"
        active={onActivity}
        badge={unread}
      />
      <AppBarItem icon={MessageSquare} label="Chat" />
      <AppBarItem to={link('/')} icon={UsersRound} label="Teams" active={!onActivity} />
      <AppBarItem icon={Calendar} label="Calendar" />
      <AppBarItem icon={Phone} label="Calls" />
    </nav>
  );
}

function AppBarItem({
  to,
  icon: Icon,
  label,
  active = false,
  badge = 0,
}: {
  to?: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  badge?: number;
}) {
  const body = (
    <>
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary"
        />
      )}
      <span className="relative">
        <Icon
          className="size-5"
          strokeWidth={active ? 2.25 : 1.75}
          fill={active ? 'currentColor' : 'none'}
          fillOpacity={active ? 0.15 : 0}
        />
        {badge > 0 && (
          <span className="absolute -top-1.5 left-3 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 font-semibold text-[10px] text-white tabular-nums ring-2 ring-chrome">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className={cn('text-[10px] leading-none', active && 'font-semibold')}>{label}</span>
    </>
  );
  const base =
    'relative flex h-14 w-[68px] flex-col items-center justify-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
  if (!to) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-disabled="true" className={cn(base, 'cursor-default text-subtle')}>
            {body}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{label} isn't part of the simulation</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      aria-label={badge > 0 ? `${label}, ${badge} unread` : label}
      className={cn(base, active ? 'text-primary' : 'text-muted-foreground hover:text-primary')}
    >
      {body}
    </Link>
  );
}
