import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  UserAvatar,
} from '@sim/ui';
import {
  AppWindow,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock,
  GitPullRequestArrow,
  Inbox,
  type LucideIcon,
  Plus,
  Search,
  Star,
  UserRound,
  UsersRound,
} from 'lucide-react';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { CURRENT_USER, CURRENT_USER_NAME, sn } from '../api';

// ---------------------------------------------------------------------------
// Contextual title (the pill in the middle of the header)
// ---------------------------------------------------------------------------

type TitleState = { path: string; title: string } | null;
const TitleContext = createContext<(t: TitleState) => void>(() => {});

/** Sets the header's contextual title (e.g. "Incident - INC0010204") for the current page. */
export function usePageTitle(title: string | undefined) {
  const set = useContext(TitleContext);
  const { pathname } = useLocation();
  useEffect(() => {
    if (title) set({ path: pathname, title });
  }, [set, pathname, title]);
}

/** Title for a path when the page hasn't set one (yet). */
function fallbackTitle(pathname: string, search: string): string {
  const [, table, id] = pathname.split('/');
  if (table === 'incidents') {
    if (id === 'new') return 'Incident - Create';
    return id ? `Incident - ${id}` : 'Incidents';
  }
  if (table === 'change_requests') {
    if (id === 'new') return 'Change Request - Create';
    return id ? `Change Request - ${id}` : 'Change Requests';
  }
  if (table === 'apps') return id ? `Business Application - ${id}` : 'Business Applications';
  if (table === 'groups') return id ? `Group - ${id}` : 'Groups';
  if (table === 'users') return id ? `User - ${id}` : 'Users';
  if (table === 'search') {
    const q = new URLSearchParams(search).get('q');
    return q ? `Search - ${q}` : 'Search';
  }
  return 'ServiceNow';
}

// ---------------------------------------------------------------------------
// Unified navigation menus
// ---------------------------------------------------------------------------

type MenuLink = { label: string; to: string; icon?: LucideIcon };

const ALL_MENU: { heading: string; items: MenuLink[] }[] = [
  {
    heading: 'Incident',
    items: [
      { label: 'Create New', to: '/incidents/new', icon: Plus },
      { label: 'Open', to: '/incidents', icon: Inbox },
      { label: 'Assigned to me', to: '/incidents?view=mine', icon: Inbox },
      { label: 'Open - Unassigned', to: '/incidents?view=unassigned', icon: Inbox },
      { label: 'All', to: '/incidents?view=all', icon: Inbox },
    ],
  },
  {
    heading: 'Change',
    items: [
      { label: 'Create New', to: '/change_requests/new', icon: Plus },
      { label: 'Open', to: '/change_requests', icon: GitPullRequestArrow },
      {
        label: 'Implemented (KBR)',
        to: '/change_requests?view=implemented',
        icon: GitPullRequestArrow,
      },
      { label: 'All', to: '/change_requests?view=all', icon: GitPullRequestArrow },
    ],
  },
  {
    heading: 'Configuration',
    items: [{ label: 'Business Applications', to: '/apps', icon: AppWindow }],
  },
  {
    heading: 'User Administration',
    items: [
      { label: 'Groups', to: '/groups', icon: UsersRound },
      { label: 'Users', to: '/users', icon: UserRound },
    ],
  },
];

const FAVORITES: MenuLink[] = [
  { label: 'Incidents - Open', to: '/incidents', icon: Star },
  { label: 'Incidents - Assigned to me', to: '/incidents?view=mine', icon: Star },
  { label: 'Incident - Create New', to: '/incidents/new', icon: Star },
  { label: 'Change Requests - Open', to: '/change_requests', icon: Star },
  { label: 'My profile', to: `/users/${CURRENT_USER}`, icon: Star },
];

const WORKSPACES: MenuLink[] = [
  { label: 'Incidents', to: '/incidents', icon: Inbox },
  { label: 'Change Requests', to: '/change_requests', icon: GitPullRequestArrow },
  { label: 'Business Applications', to: '/apps', icon: AppWindow },
  { label: 'Groups', to: '/groups', icon: UsersRound },
  { label: 'People', to: '/users', icon: UserRound },
];

const navButtonClass =
  'inline-flex h-12 items-center gap-1 border-b-2 border-transparent px-2.5 text-[14px] text-nav-foreground outline-none transition-colors hover:bg-nav-hover focus-visible:bg-nav-hover data-[state=open]:border-brand-green data-[state=open]:bg-nav-hover';

function NavMenu({
  label,
  children,
  active,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className={cn(navButtonClass, active && 'border-brand-green')}>
        {label}
        <ChevronDown className="size-3.5 text-nav-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" sideOffset={0}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItems({ items }: { items: MenuLink[] }) {
  return items.map((item) => (
    <DropdownMenuItem key={item.to + item.label} asChild className="py-1.5 text-[13px]">
      <Link to={item.to}>
        {item.icon && <item.icon className="text-muted-foreground" />}
        {item.label}
      </Link>
    </DropdownMenuItem>
  ));
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

function Wordmark() {
  return (
    <Link
      to="/incidents"
      className="flex shrink-0 items-center px-1 font-bold text-[17px] sm:text-[19px] text-nav-foreground tracking-tight"
    >
      <span aria-hidden="true" className="flex items-center">
        service
        <span>n</span>
        <span className="mx-[1px] inline-block size-[14px] translate-y-[1px] rounded-full border-[3px] border-brand-green" />
        <span>w</span>
      </span>
      <span className="sr-only">ServiceNow home</span>
    </Link>
  );
}

function GlobalSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    const inc = q.match(/^inc\s*0*(\d+)$/i);
    if (inc) {
      navigate(`/incidents/INC${inc[1]!.padStart(7, '0')}`);
    } else if (/^[a-z]{3}$/i.test(q)) {
      const tla = q.toUpperCase();
      const exists = await sn.getApp(tla).then(
        () => true,
        () => false,
      );
      navigate(exists ? `/apps/${tla}` : `/search?q=${encodeURIComponent(q)}`);
    } else {
      navigate(`/search?q=${encodeURIComponent(q)}`);
    }
    setValue('');
  };

  return (
    <form onSubmit={submit} className="relative w-24 sm:w-56 xl:w-64" role="search">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-nav-muted" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search"
        title="Search INC number, TLA, people…"
        aria-label="Global search"
        className="h-8 w-full rounded-full border border-white/20 bg-white/10 pr-3 pl-9 text-[13px] text-nav-foreground outline-none transition-colors placeholder:text-nav-muted hover:bg-white/15 focus:border-white/60 focus:bg-white/15"
      />
    </form>
  );
}

function IconButton({ label, children, to }: { label: string; children: ReactNode; to?: string }) {
  const cls =
    'inline-flex size-9 items-center justify-center rounded-full text-nav-foreground outline-none transition-colors hover:bg-nav-hover focus-visible:bg-nav-hover [&_svg]:size-[18px]';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {to ? (
          <Link to={to} aria-label={label} className={cls}>
            {children}
          </Link>
        ) : (
          <button type="button" aria-label={label} className={cls}>
            {children}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Layout({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const [pageTitle, setPageTitle] = useState<TitleState>(null);
  const [history, setHistory] = useState<MenuLink[]>([]);
  const title =
    pageTitle && pageTitle.path === pathname ? pageTitle.title : fallbackTitle(pathname, search);

  useEffect(() => {
    document.title = `${title} | ServiceNow`;
    setHistory((h) =>
      [{ label: title, to: pathname + search }, ...h.filter((x) => x.to !== pathname + search)]
        .filter((x, i, all) => all.findIndex((y) => y.label === x.label) === i)
        .slice(0, 10),
    );
  }, [title, pathname, search]);

  return (
    <TooltipProvider delayDuration={300}>
      <TitleContext.Provider value={setPageTitle}>
        <div className="flex min-h-svh w-full min-w-0 flex-col bg-background">
          <header className="sticky top-0 z-20 h-12 shrink-0 bg-nav text-nav-foreground shadow-[0_1px_3px_rgb(0_0_0/0.25)]">
            <div className="relative flex h-full items-center gap-1 px-3">
              <Wordmark />
              <nav aria-label="Unified navigation" className="flex items-center md:ml-3">
                <NavMenu label="All">
                  {ALL_MENU.map((group, i) => (
                    <DropdownMenuGroup key={group.heading}>
                      {i > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="font-semibold text-foreground text-xs">
                        {group.heading}
                      </DropdownMenuLabel>
                      <MenuItems items={group.items} />
                    </DropdownMenuGroup>
                  ))}
                </NavMenu>
                <div className="hidden md:contents">
                  <NavMenu label="Favorites">
                    <MenuItems items={FAVORITES} />
                  </NavMenu>
                  <NavMenu label="History">
                    {history.length === 0 ? (
                      <DropdownMenuLabel className="text-[13px]">No history yet</DropdownMenuLabel>
                    ) : (
                      <MenuItems items={history.map((h) => ({ ...h, icon: Clock }))} />
                    )}
                  </NavMenu>
                  <NavMenu label="Workspaces">
                    <DropdownMenuLabel className="font-semibold text-foreground text-xs">
                      Service Operations
                    </DropdownMenuLabel>
                    <MenuItems items={WORKSPACES} />
                  </NavMenu>
                </div>
              </nav>

              <div className="pointer-events-none absolute inset-x-0 hidden justify-center xl:flex">
                <div className="pointer-events-auto flex h-8 max-w-[min(30vw,calc(100vw-1000px))] items-center gap-2 rounded-full bg-white/10 pr-2 pl-4 text-[14px] text-nav-foreground">
                  <span className="truncate font-semibold">{title}</span>
                  <Star className="size-4 shrink-0 text-nav-muted" aria-hidden="true" />
                </div>
              </div>

              <div className="relative ml-auto flex items-center gap-1">
                <GlobalSearch />
                <span
                  className="mx-1 hidden rounded-full border border-white/25 px-2 py-0.5 text-[10px] text-nav-muted uppercase tracking-wider xl:inline"
                  title="This is a simulated ServiceNow instance"
                >
                  Simulated
                </span>
                <span className="hidden sm:contents">
                  <IconButton label="Help: search takes INC numbers, TLAs, names and text">
                    <CircleHelp />
                  </IconButton>
                </span>
                <IconButton
                  label="Notifications: incidents assigned to me"
                  to="/incidents?view=mine"
                >
                  <Bell />
                </IconButton>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/users/${CURRENT_USER}`}
                      aria-label={CURRENT_USER_NAME}
                      className="ml-1 inline-flex rounded-full outline-none ring-white/60 focus-visible:ring-2"
                    >
                      <UserAvatar name={CURRENT_USER_NAME} size="sm" className="size-8" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    {CURRENT_USER_NAME}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </header>
          <main className="min-w-0 flex-1 p-4">{children}</main>
        </div>
      </TitleContext.Provider>
    </TooltipProvider>
  );
}

/** Page body: a full-width column of sections. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-w-0 space-y-4', className)}>{children}</div>;
}
