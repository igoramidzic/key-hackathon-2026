import type { Branch, Tag } from '@sim/contracts/gitlab';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  RelativeTime,
  UserAvatar,
} from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Download,
  FileText,
  Folder,
  GitBranch,
  History,
  Tag as TagIcon,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { api, BASE_PATH, blobHref, commitsHref, treeHref } from '../lib/api';
import { CopyButton, Loadable, Markdown, Section, ShortSha, UserLink } from './common';

export function RefSwitcher({
  current,
  branches,
  tags,
  hrefFor,
}: {
  current: string;
  branches: Branch[];
  tags: Tag[];
  hrefFor: (ref: string) => string;
}) {
  const navigate = useNavigate();
  const isTag = tags.some((t) => t.name === current);
  const item = (name: string) => (
    <DropdownMenuItem key={name} onSelect={() => navigate(hrefFor(name))} className="font-mono">
      <Check className={cn(name === current ? 'opacity-100' : 'opacity-0')} />
      <span className="truncate">{name}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-56">
          {isTag ? <TagIcon data-icon="inline-start" /> : <GitBranch data-icon="inline-start" />}
          <span className="truncate font-mono">
            {current.length === 40 ? current.slice(0, 8) : current}
          </span>
          <ChevronDown data-icon="inline-end" className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuLabel>Branches</DropdownMenuLabel>
        {branches.map((b) => item(b.name))}
        {tags.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Tags</DropdownMenuLabel>
            {tags.map((t) => item(t.name))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PathCrumbs({
  projectPath,
  projectName,
  gitRef,
  path,
}: {
  projectPath: string;
  projectName: string;
  gitRef: string;
  path: string;
}) {
  const parts = path ? path.split('/') : [];
  const link = 'text-gl-link hover:underline';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      <Link to={treeHref(projectPath, gitRef)} className={link}>
        {projectName}
      </Link>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-muted-foreground">/</span>
          {i === parts.length - 1 ? (
            <span className="font-semibold text-gl-strong">{p}</span>
          ) : (
            <Link
              to={treeHref(projectPath, gitRef, parts.slice(0, i + 1).join('/'))}
              className={link}
            >
              {p}
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}

/** GitLab's blue "Code" dropdown: clone URL and source download. */
function CodeMenu({ projectPath, gitRef }: { projectPath: string; gitRef: string }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const cloneUrl = `${origin}${BASE_PATH}/${projectPath}.git`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          Code
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="grid gap-1.5 border-b p-3">
          <span className="font-semibold text-gl-strong text-xs">Clone with HTTPS</span>
          <span className="flex items-center gap-1">
            <Input
              readOnly
              value={cloneUrl}
              aria-label="Clone URL"
              className="font-mono text-[12px]"
            />
            <CopyButton text={cloneUrl} label="Copy URL" />
          </span>
        </div>
        <DropdownMenuLabel className="px-3 pt-2">Download source code</DropdownMenuLabel>
        <DropdownMenuItem asChild className="mx-1 mb-1">
          <a href={api.archiveUrl(projectPath, gitRef)}>
            <Download />
            tar.gz
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Latest commit" bar shown above the file list. */
export function LastCommitBar({
  projectPath,
  gitRef,
  path,
}: {
  projectPath: string;
  gitRef: string;
  path?: string;
}) {
  const q = useQuery({
    queryKey: ['commits', projectPath, gitRef, path ?? '', 'last'],
    queryFn: () =>
      api.listCommits(projectPath, { ref_name: gitRef, path: path || undefined, limit: 1 }),
    refetchInterval: 10_000,
  });
  const c = q.data?.items[0];
  if (!c) return <div className="h-[66px] rounded-(--radius) border" />;
  return (
    <div className="flex items-center gap-3 rounded-(--radius) border px-4 py-3">
      <UserAvatar name={c.author_name} size="md" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/${projectPath}/-/commit/${c.id}`}
          className="block truncate font-semibold text-gl-strong text-xs hover:text-gl-link hover:underline"
        >
          {c.title}
        </Link>
        <div className="text-muted-foreground text-xs">
          <UserLink
            user={{ username: c.author_username, name: c.author_name }}
            className="font-normal text-muted-foreground"
          />{' '}
          authored <RelativeTime value={c.authored_date} />
        </div>
      </div>
      <span className="flex items-center gap-1">
        <ShortSha projectPath={projectPath} sha={c.id} />
        <CopyButton text={c.id} label="Copy commit SHA" />
      </span>
    </div>
  );
}

/** File list for a directory at a ref, with the latest commit bar and README. */
export function RepoBrowser({
  projectPath,
  projectName,
  gitRef,
  path,
  branches,
  tags,
  showReadme = true,
}: {
  projectPath: string;
  projectName: string;
  gitRef: string;
  path: string;
  branches: Branch[];
  tags: Tag[];
  showReadme?: boolean;
}) {
  const tree = useQuery({
    queryKey: ['tree', projectPath, gitRef, path],
    queryFn: () => api.getTree(projectPath, { ref: gitRef, path: path || undefined }),
    refetchInterval: 10_000,
  });
  const readmeEntry = tree.data?.find((e) => e.type === 'blob' && /^readme(\.md)?$/i.test(e.name));
  const readme = useQuery({
    queryKey: ['file', projectPath, gitRef, readmeEntry?.path],
    queryFn: () => api.getFile(projectPath, readmeEntry!.path, gitRef),
    enabled: showReadme && Boolean(readmeEntry),
  });
  const row =
    'flex items-center gap-2 px-4 py-2 text-xs text-foreground transition-colors hover:bg-gl-subtle [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher
          current={gitRef}
          branches={branches}
          tags={tags}
          hrefFor={(r) => treeHref(projectPath, r, path)}
        />
        <PathCrumbs
          projectPath={projectPath}
          projectName={projectName}
          gitRef={gitRef}
          path={path}
        />
        <span className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to={commitsHref(projectPath, gitRef, path)}>
              <History data-icon="inline-start" />
              History
            </Link>
          </Button>
          <CodeMenu projectPath={projectPath} gitRef={gitRef} />
        </span>
      </div>
      <LastCommitBar projectPath={projectPath} gitRef={gitRef} path={path} />
      <div className="overflow-hidden rounded-(--radius) border">
        <div className="border-b bg-gl-subtle px-4 py-2.5 font-semibold text-gl-strong text-xs">
          Name
        </div>
        <Loadable query={tree}>
          {(entries) => (
            <ul className="divide-y">
              {path && (
                <li>
                  <Link
                    to={treeHref(projectPath, gitRef, path.split('/').slice(0, -1).join('/'))}
                    className={cn(row, 'text-muted-foreground')}
                  >
                    <Folder />
                    ..
                  </Link>
                </li>
              )}
              {entries.map((e) => (
                <li key={e.path}>
                  <Link
                    to={
                      e.type === 'tree'
                        ? treeHref(projectPath, gitRef, e.path)
                        : blobHref(projectPath, gitRef, e.path)
                    }
                    className={row}
                  >
                    {e.type === 'tree' ? (
                      <Folder className="fill-muted-foreground/20" />
                    ) : (
                      <FileText />
                    )}
                    <span className="truncate hover:text-gl-link hover:underline">{e.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Loadable>
      </div>
      {showReadme && readme.data && (
        <Section
          title={
            <span className="inline-flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              {readme.data.file_name}
            </span>
          }
          bodyClassName="px-6 py-5"
        >
          {readme.data.file_name.toLowerCase().endsWith('.md') ? (
            <Markdown source={readme.data.content} />
          ) : (
            <pre className="whitespace-pre-wrap text-xs">{readme.data.content}</pre>
          )}
        </Section>
      )}
    </div>
  );
}
