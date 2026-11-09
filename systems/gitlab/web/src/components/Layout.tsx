import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Sheet,
  SheetContent,
  SheetTitle,
  SystemLogo,
  UserAvatar,
  useDebounced,
} from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import {
  ChartLine,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code,
  Container,
  Monitor,
  PanelLeft,
  Pin,
  Plus,
  Rocket,
  Search,
  Settings,
  Shield,
  SquareKanban,
  Users,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { api, loadMergeAs, ORG } from '../lib/api';
import { useRefs } from '../lib/refs';
import { EntityAvatar } from './common';

interface Ctx {
  group?: string;
  project?: string;
  section?: string;
  rest: string[];
}

function parseContext(pathname: string): Ctx {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== ORG) return { rest: parts };
  const group = parts[1];
  const project = parts[2] && parts[2] !== '-' ? parts[2] : undefined;
  const dash = parts.indexOf('-');
  return {
    group,
    project,
    section: dash >= 0 ? parts[dash + 1] : undefined,
    rest: dash >= 0 ? parts.slice(dash + 2) : [],
  };
}

// ---------------------------------------------------------------------------
// Sidebar building blocks (GitLab's "super sidebar")
// ---------------------------------------------------------------------------

const NOT_SIMULATED = 'Not part of the simulation';

const itemBase =
  'relative flex h-8 w-full items-center gap-3 rounded-(--radius) px-2 text-left text-foreground text-xs transition-colors [&_svg]:size-4 [&_svg]:shrink-0';

/** Active item: gray fill and a short bar on the left edge, like GitLab. */
const itemActive =
  'bg-black/[0.08] font-semibold text-gl-strong before:absolute before:top-1.5 before:bottom-1.5 before:left-0.5 before:w-[3px] before:rounded-full before:bg-primary';

function NavCount({ value }: { value?: number }) {
  if (value === undefined) return null;
  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-black/[0.08] px-1.5 font-normal text-[12px] text-muted-foreground tabular-nums">
      {value}
    </span>
  );
}

interface NavEntry {
  label: string;
  /** Omit for pages the simulation doesn't have; they render as inert, muted items. */
  to?: string;
  active?: boolean;
  count?: number;
}

function NavItem({
  entry,
  icon,
  indent,
  onNavigate,
}: {
  entry: NavEntry;
  icon?: ReactNode;
  indent?: boolean;
  onNavigate?: () => void;
}) {
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      <NavCount value={entry.count} />
    </>
  );
  const pad = indent && 'pl-9';
  if (!entry.to) {
    return (
      <li>
        <span
          aria-disabled="true"
          title={NOT_SIMULATED}
          className={cn(itemBase, pad, 'cursor-default text-gl-gray-500')}
        >
          {body}
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        to={entry.to}
        onClick={onNavigate}
        aria-current={entry.active ? 'page' : undefined}
        className={cn(itemBase, pad, entry.active ? itemActive : 'hover:bg-black/[0.06]')}
      >
        {body}
      </Link>
    </li>
  );
}

function NavSection({
  title,
  icon,
  items,
  onNavigate,
}: {
  title: string;
  icon: ReactNode;
  items: NavEntry[];
  onNavigate?: () => void;
}) {
  const hasActive = items.some((i) => i.active);
  const [open, setOpen] = useState(hasActive);
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          itemBase,
          'hover:bg-black/[0.06]',
          hasActive && !open && itemActive,
          '[&_svg]:text-muted-foreground',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {open ? <ChevronDown className="size-4!" /> : <ChevronRight className="size-4!" />}
      </button>
      {open && (
        <ul className="grid gap-px pb-1">
          {items.map((item) => (
            <NavItem key={item.label} entry={item} indent onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}

function PinnedSection({ items, onNavigate }: { items: NavEntry[]; onNavigate?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <li className="border-b pb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(itemBase, 'hover:bg-black/[0.06] [&_svg]:text-muted-foreground')}
      >
        <Pin />
        <span className="flex-1">Pinned</span>
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      {open && (
        <ul className="grid gap-px">
          {items.map((item) => (
            <NavItem key={item.label} entry={item} indent onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The context's own item at the top of the nav: avatar tile and name, links to the overview. */
function ContextItem({
  to,
  name,
  active,
  onNavigate,
}: {
  to: string;
  name: string;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <li>
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        title={name}
        className={cn(
          itemBase,
          'h-9 gap-2',
          active ? itemActive : 'font-semibold text-gl-strong hover:bg-black/[0.06]',
        )}
      >
        <EntityAvatar name={name} size="sm" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </Link>
    </li>
  );
}

const disabled = (...labels: string[]): NavEntry[] => labels.map((label) => ({ label }));

function ProjectNav({ ctx, onNavigate }: { ctx: Ctx; onNavigate?: () => void }) {
  const projectPath = `${ORG}/${ctx.group}/${ctx.project}`;
  const project = useQuery({
    queryKey: ['project', projectPath],
    queryFn: () => api.getProject(projectPath),
    refetchInterval: 10_000,
  });
  const refs = useRefs(projectPath);
  const base = `/${projectPath}`;
  const ref = project.data?.default_branch ?? 'main';
  const s = ctx.section;
  const latestTag = refs.data?.tags[0]?.name;
  const mrs: NavEntry = {
    label: 'Merge requests',
    to: `${base}/-/merge_requests`,
    active: s === 'merge_requests',
    count: project.data?.open_merge_requests_count,
  };
  return (
    <>
      <ContextItem to={base} name={ctx.project!} active={!s} onNavigate={onNavigate} />
      <PinnedSection items={[mrs]} onNavigate={onNavigate} />
      <NavSection
        title="Manage"
        icon={<Users />}
        items={disabled('Activity', 'Members', 'Labels')}
      />
      <NavSection
        title="Plan"
        icon={<SquareKanban />}
        items={disabled('Issues', 'Issue boards', 'Milestones', 'Wiki')}
      />
      <NavSection
        title="Code"
        icon={<Code />}
        onNavigate={onNavigate}
        items={[
          { ...mrs, count: undefined },
          {
            label: 'Repository',
            to: `${base}/-/tree/${ref}`,
            active: s === 'tree' || s === 'blob',
          },
          { label: 'Branches', to: `${base}/-/branches`, active: s === 'branches' },
          {
            label: 'Commits',
            to: `${base}/-/commits/${ref}`,
            active: s === 'commits' || s === 'commit',
          },
          { label: 'Tags', to: `${base}/-/tags`, active: s === 'tags' },
          { label: 'Repository graph' },
          {
            label: 'Compare revisions',
            to: latestTag ? `${base}/-/compare/${latestTag}...${ref}` : undefined,
            active: s === 'compare',
          },
          { label: 'Snippets' },
        ]}
      />
      <NavSection
        title="Build"
        icon={<Rocket />}
        items={[
          { label: 'Pipelines', active: s === 'pipelines' },
          ...disabled('Jobs', 'Pipeline editor', 'Artifacts'),
        ]}
      />
      <NavSection title="Secure" icon={<Shield />} items={disabled('Security configuration')} />
      <NavSection
        title="Deploy"
        icon={<Container />}
        items={disabled('Releases', 'Package registry')}
      />
      <NavSection
        title="Operate"
        icon={<Cloud />}
        items={disabled('Environments', 'Kubernetes clusters')}
      />
      <NavSection title="Monitor" icon={<Monitor />} items={disabled('Incidents', 'Alerts')} />
      <NavSection
        title="Analyze"
        icon={<ChartLine />}
        items={disabled('Value stream analytics', 'Contributor analytics')}
      />
      <NavSection
        title="Settings"
        icon={<Settings />}
        items={disabled('General', 'Repository', 'Merge requests', 'CI/CD')}
      />
    </>
  );
}

function GroupNav({
  group,
  hash,
  onNavigate,
}: {
  group: string;
  hash: string;
  onNavigate?: () => void;
}) {
  const base = `/${ORG}/${group}`;
  const mrs: NavEntry = {
    label: 'Merge requests',
    to: `${base}#merge-requests`,
    active: hash === '#merge-requests',
  };
  return (
    <>
      <ContextItem
        to={base}
        name={group}
        active={hash !== '#merge-requests'}
        onNavigate={onNavigate}
      />
      <PinnedSection items={[mrs]} onNavigate={onNavigate} />
      <NavSection
        title="Manage"
        icon={<Users />}
        items={disabled('Activity', 'Members', 'Labels')}
      />
      <NavSection
        title="Plan"
        icon={<SquareKanban />}
        items={disabled('Issues', 'Epics', 'Milestones')}
      />
      <NavSection
        title="Code"
        icon={<Code />}
        onNavigate={onNavigate}
        items={[{ ...mrs, active: false }]}
      />
      <NavSection title="Build" icon={<Rocket />} items={disabled('Runners')} />
      <NavSection
        title="Settings"
        icon={<Settings />}
        items={disabled('General', 'Integrations', 'CI/CD')}
      />
    </>
  );
}

function YourWorkNav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const items: NavEntry[] = [
    { label: 'Projects' },
    { label: 'Groups', to: `/${ORG}`, active: pathname === `/${ORG}` },
    { label: 'Issues' },
    {
      label: 'Merge requests',
      to: '/dashboard/merge_requests',
      active: pathname.startsWith('/dashboard/merge_requests'),
    },
    { label: 'To-Do List' },
    { label: 'Milestones' },
    { label: 'Snippets' },
    { label: 'Activity', to: '/', active: pathname === '/' },
  ];
  return (
    <>
      <li className="px-2 pt-1 pb-1.5 font-semibold text-gl-strong text-xs">Your work</li>
      {items.map((item) => (
        <NavItem key={item.label} entry={item} onNavigate={onNavigate} />
      ))}
    </>
  );
}

function CreateMenu({ inProject }: { inProject: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Create new…"
          title="Create new…"
          className="hover:bg-black/[0.06]"
        >
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {inProject && (
          <>
            <DropdownMenuLabel>In this project</DropdownMenuLabel>
            <DropdownMenuItem disabled>New issue</DropdownMenuItem>
            <DropdownMenuItem disabled>New merge request</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>In GitLab</DropdownMenuLabel>
        <DropdownMenuItem disabled>New project/repository</DropdownMenuItem>
        <DropdownMenuItem disabled>New group</DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-muted-foreground text-[12px]">{NOT_SIMULATED}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const username = loadMergeAs();
  const user = useQuery({
    queryKey: ['user', username],
    queryFn: () => api.getUser(username),
    retry: false,
  });
  const name = user.data?.name ?? username;
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${name} user’s menu`}
          className="flex h-8 items-center gap-0.5 rounded-(--radius) px-1 hover:bg-black/[0.06]"
        >
          <UserAvatar name={name} size="xs" className="size-6" />
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="font-semibold text-gl-strong">{name}</span>
          <span className="font-normal text-muted-foreground">@{username}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onNavigate?.();
            navigate(`/${username}`);
          }}
        >
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem disabled>Preferences</DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-muted-foreground text-[12px]">
          The merge request page picks who you act as.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Sidebar({
  ctx,
  pathname,
  hash,
  onSearch,
  onNavigate,
}: {
  ctx: Ctx;
  pathname: string;
  hash: string;
  onSearch: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <Link
          to="/"
          onClick={onNavigate}
          title="Homepage"
          className="flex size-8 items-center justify-center rounded-(--radius) hover:bg-black/[0.06]"
        >
          <SystemLogo system="gitlab" className="size-6" />
          <span className="sr-only">Homepage</span>
        </Link>
        <span className="flex-1" />
        <CreateMenu inProject={Boolean(ctx.project)} />
        <UserMenu onNavigate={onNavigate} />
      </div>
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-8 w-full items-center gap-2 rounded-(--radius) border border-gl-gray-300 bg-background px-2 text-left text-muted-foreground text-xs transition-colors hover:border-gl-gray-500"
        >
          <Search className="size-4 shrink-0" />
          <span className="flex-1">Search or go to…</span>
          <kbd className="rounded-[3px] border px-1 font-mono text-[11px] text-muted-foreground">
            /
          </kbd>
        </button>
      </div>
      <nav
        aria-label={
          ctx.project ? 'Project navigation' : ctx.group ? 'Group navigation' : 'Your work'
        }
        className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3"
      >
        <ul className="grid gap-px">
          {ctx.group && ctx.project ? (
            <ProjectNav ctx={ctx} onNavigate={onNavigate} />
          ) : ctx.group ? (
            <GroupNav group={ctx.group} hash={hash} onNavigate={onNavigate} />
          ) : (
            <YourWorkNav pathname={pathname} onNavigate={onNavigate} />
          )}
        </ul>
      </nav>
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2.5 text-muted-foreground text-[12px]">
        <span className="rounded-full border border-dashed border-gl-gray-500 px-2 py-px font-medium uppercase tracking-wide text-[10px]">
          Simulated
        </span>
        <span className="truncate">not a live instance</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

const SECTION_LABEL: Record<string, string> = {
  tree: 'Repository',
  blob: 'Repository',
  commits: 'Commits',
  commit: 'Commits',
  merge_requests: 'Merge requests',
  branches: 'Branches',
  tags: 'Tags',
  compare: 'Compare revisions',
  pipelines: 'Pipelines',
};

interface Crumb {
  label: string;
  to: string;
  avatar?: boolean;
}

function crumbsFor(ctx: Ctx, pathname: string): Crumb[] {
  const crumbs: Crumb[] = [];
  if (ctx.group !== undefined) {
    crumbs.push({ label: 'KeyBank', to: `/${ORG}`, avatar: true });
    if (ctx.group) crumbs.push({ label: ctx.group, to: `/${ORG}/${ctx.group}`, avatar: true });
    if (ctx.project) {
      crumbs.push({
        label: ctx.project,
        to: `/${ORG}/${ctx.group}/${ctx.project}`,
        avatar: true,
      });
    }
    if (ctx.section && SECTION_LABEL[ctx.section]) {
      const base = `/${ORG}/${ctx.group}/${ctx.project}/-`;
      const to =
        ctx.section === 'commit'
          ? `${base}/commits/main`
          : ctx.section === 'blob' || ctx.section === 'tree'
            ? `${base}/tree/main`
            : ctx.section === 'merge_requests' || ctx.section === 'branches'
              ? `${base}/${ctx.section}`
              : ctx.section === 'tags'
                ? `${base}/tags`
                : pathname;
      crumbs.push({ label: SECTION_LABEL[ctx.section]!, to });
      if (ctx.section === 'merge_requests' && ctx.rest[0]) {
        crumbs.push({ label: `!${ctx.rest[0]}`, to: `${base}/merge_requests/${ctx.rest[0]}` });
      }
      if (ctx.section === 'commit' && ctx.rest[0]) {
        crumbs.push({ label: ctx.rest[0].slice(0, 8), to: `${base}/commit/${ctx.rest[0]}` });
      }
      if (ctx.section === 'pipelines' && ctx.rest[0]) {
        crumbs.push({ label: `#${ctx.rest[0]}`, to: pathname });
      }
    }
  } else if (ctx.rest[0] === 'dashboard') {
    crumbs.push(
      { label: 'Your work', to: '/' },
      { label: 'Merge requests', to: '/dashboard/merge_requests' },
    );
  } else if (ctx.rest.length === 0) {
    crumbs.push({ label: 'Your work', to: '/' }, { label: 'Activity', to: '/' });
  } else if (ctx.rest.length === 1) {
    crumbs.push({ label: ctx.rest[0]!, to: `/${ctx.rest[0]}` });
  }
  return crumbs;
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-xs">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li
              key={c.to + i}
              className={cn(
                'flex min-w-0 items-center gap-1',
                i < crumbs.length - 2 && 'max-sm:hidden',
                i === crumbs.length - 2 && 'max-sm:[&>span:first-child]:hidden',
              )}
            >
              {i > 0 && <span className="px-0.5 text-gl-gray-500">/</span>}
              <Link
                to={c.to}
                aria-current={last ? 'page' : undefined}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 hover:underline',
                  last ? 'text-gl-strong' : 'text-muted-foreground hover:text-gl-strong',
                )}
              >
                {c.avatar && <EntityAvatar name={c.label} size="xs" />}
                <span className="truncate">{c.label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function SearchBox({
  autoFocus,
  className,
  size = 'default',
  inline = false,
  onGo,
  placeholder = 'Search projects, apps or TLAs…',
}: {
  autoFocus?: boolean;
  className?: string;
  size?: 'sm' | 'default';
  /** Results in the flow below the field (the search dialog) instead of a popover. */
  inline?: boolean;
  onGo?: () => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(term.trim(), 200);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: async () => {
      const [projects, groups] = await Promise.all([
        api.listProjects({ search: debounced, limit: 8 }),
        api.listGroups({ search: debounced, limit: 4 }),
      ]);
      return { projects: projects.items, groups: groups.items.filter((g) => g.tla) };
    },
    enabled: debounced.length >= 2,
  });
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  const go = (to: string) => {
    setOpen(false);
    setTerm('');
    onGo?.();
    navigate(to);
  };
  const first = results.data?.projects[0];
  const row =
    'flex w-full items-center gap-2.5 rounded-(--radius) px-2.5 py-1.5 text-left transition-colors hover:bg-muted';
  const heading = 'px-2.5 pt-2 pb-1 font-semibold text-[12px] text-gl-strong';
  const showResults = (inline || open) && debounced.length >= 2 && results.data;
  return (
    <div ref={box} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-[1.0625rem] left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        autoFocus={autoFocus}
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) go(`/${first.path_with_namespace}`);
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={placeholder}
        aria-label="Search projects and groups"
        className={cn('h-[2.125rem] bg-background pl-8', size === 'sm' && 'h-7')}
      />
      {showResults && (
        <div
          className={cn(
            'max-h-96 overflow-y-auto py-1 text-xs',
            inline
              ? 'mt-2'
              : 'absolute top-full right-0 z-30 mt-1 w-full min-w-96 rounded-(--radius) bg-popover text-popover-foreground shadow-md ring-1 ring-border',
          )}
        >
          {results.data.groups.length > 0 && <div className={heading}>Groups</div>}
          {results.data.groups.map((g) => (
            <button key={g.id} type="button" onClick={() => go(`/${g.full_path}`)} className={row}>
              <EntityAvatar name={g.name} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-gl-strong">{g.full_path}</span>
                <span className="block truncate text-muted-foreground text-[12px]">
                  {g.description}
                </span>
              </span>
            </button>
          ))}
          {results.data.projects.length > 0 && <div className={heading}>Projects</div>}
          {results.data.projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => go(`/${p.path_with_namespace}`)}
              className={row}
            >
              <EntityAvatar name={p.name} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-gl-strong">{p.name}</span>
                <span className="block truncate text-muted-foreground text-[12px]">
                  {p.path_with_namespace} · {p.app_name}
                </span>
              </span>
            </button>
          ))}
          {results.data.projects.length === 0 && results.data.groups.length === 0 && (
            <div className="px-2.5 py-2 text-muted-foreground">No results for “{debounced}”</div>
          )}
        </div>
      )}
    </div>
  );
}

function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-16 translate-y-0 gap-0 p-2 sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Search or go to</DialogTitle>
        <SearchBox
          autoFocus
          inline
          onGo={() => onOpenChange(false)}
          placeholder="Search projects and groups (TLA, app or project name)…"
        />
        <div className="mt-2 border-t px-2.5 pt-2 pb-0.5 text-muted-foreground text-[12px]">
          Type at least two characters. Press Enter to open the first project.
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Layout() {
  const location = useLocation();
  const ctx = parseContext(location.pathname);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to top on navigation
  useEffect(() => {
    if (!location.hash) window.scrollTo({ top: 0 });
  }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!typing && (e.key === '/' || e.key === 's') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const sidebar = (onNavigate?: () => void) => (
    <Sidebar
      ctx={ctx}
      pathname={location.pathname}
      hash={location.hash}
      onSearch={() => {
        onNavigate?.();
        setSearchOpen(true);
      }}
      onNavigate={onNavigate}
    />
  );
  return (
    <div className="flex min-h-svh w-full bg-background">
      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 border-r bg-gl-subtle md:block">
        {sidebar()}
      </aside>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-64 bg-gl-subtle p-0"
          aria-describedby={undefined}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar(() => setMobileNav(false))}
        </SheetContent>
      </Sheet>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 lg:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-1 md:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileNav(true)}
          >
            <PanelLeft />
          </Button>
          <Breadcrumbs crumbs={crumbsFor(ctx, location.pathname)} />
        </header>
        <main className="min-w-0 flex-1 px-4 pt-4 pb-10 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
