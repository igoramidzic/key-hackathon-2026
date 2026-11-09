import { URLS } from '@sim/contracts';
import {
  Button,
  Card,
  CodeBlock,
  cn,
  EmptyState,
  ErrorState,
  LoadMore,
  RelativeTime,
  Spinner,
} from '@sim/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Tag as TagIcon,
  X,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  CopyButton,
  codeChip,
  dayLabel,
  EntityAvatar,
  GlBadge,
  glLink,
  Loadable,
  Markdown,
  PageTitle,
  refChip,
  Section,
  ShortSha,
  StackBadge,
  UserLink,
} from '../components/common';
import { DiffView } from '../components/DiffView';
import { CommitList } from '../components/lists';
import { PathCrumbs, RefSwitcher, RepoBrowser } from '../components/RepoBrowser';
import { api, BASE_PATH, commitsHref, groupHref, mrHref, ORG, treeHref } from '../lib/api';
import { useProjectPath } from '../lib/project';
import { useRefPath, useRefs } from '../lib/refs';

export function ProjectPage() {
  const { path, name } = useProjectPath();
  const project = useQuery({
    queryKey: ['project', path],
    queryFn: () => api.getProject(path),
    refetchInterval: 10_000,
  });
  const refs = useRefs(path);
  return (
    <Loadable query={project}>
      {(p) => (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3 border-b pb-4">
            <EntityAvatar name={p.name} size="lg" />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <h1 className="font-semibold text-2xl text-gl-strong">{p.name}</h1>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
                Project ID: {p.id}
                <CopyButton text={String(p.id)} label="Copy project ID" />
              </span>
            </div>
          </div>
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
            <RepoBrowser
              projectPath={path}
              projectName={name}
              gitRef={p.default_branch}
              path=""
              branches={refs.data?.branches ?? []}
              tags={refs.data?.tags ?? []}
            />
            <aside aria-label="Project information" className="grid gap-4 text-xs">
              <h2 className="font-semibold text-base text-gl-strong">Project information</h2>
              {p.description && <p className="text-foreground">{p.description}</p>}
              <ul className="grid gap-2">
                {[
                  {
                    to: commitsHref(path),
                    icon: <GitCommitHorizontal />,
                    n: p.commit_count,
                    label: 'Commits',
                  },
                  {
                    to: `/${path}/-/branches`,
                    icon: <GitBranch />,
                    n: p.branches_count,
                    label: 'Branches',
                  },
                  { to: `/${path}/-/tags`, icon: <TagIcon />, n: p.tags_count, label: 'Tags' },
                  {
                    to: `/${path}/-/merge_requests`,
                    icon: <GitMerge />,
                    n: p.open_merge_requests_count,
                    label: 'Open merge requests',
                  },
                ].map((s) => (
                  <li key={s.label}>
                    <Link
                      to={s.to}
                      className="inline-flex items-center gap-2 text-foreground hover:text-gl-link hover:underline [&_svg]:size-4 [&_svg]:text-muted-foreground"
                    >
                      {s.icon}
                      <span>
                        <span className="font-semibold tabular-nums">{s.n}</span> {s.label}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="grid gap-2 border-t pt-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StackBadge stack={p.stack} />
                </div>
                <Link to={groupHref(p.namespace.full_path)} className={glLink}>
                  {p.tla} · {p.app_name}
                </Link>
                <a
                  href={`${URLS.servicenow.web}/apps/${p.tla}`}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(glLink, 'inline-flex items-center gap-1')}
                >
                  ServiceNow application <ExternalLink className="size-3.5" />
                </a>
              </div>
              {p.upstream_tlas.length > 0 && (
                <div className="grid gap-1.5 border-t pt-4">
                  <span className="font-semibold text-gl-strong">Calls</span>
                  <div className="flex flex-wrap gap-1">
                    {p.upstream_tlas.map((t) => (
                      <Link key={t} to={`/${ORG}/${t}00`} className={refChip}>
                        {t}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {p.downstream_tlas.length > 0 && (
                <div className="grid gap-1.5 border-t pt-4">
                  <span className="font-semibold text-gl-strong">Called by</span>
                  <div className="flex flex-wrap gap-1">
                    {p.downstream_tlas.slice(0, 12).map((t) => (
                      <Link key={t} to={`/${ORG}/${t}00`} className={refChip}>
                        {t}
                      </Link>
                    ))}
                    {p.downstream_tlas.length > 12 && (
                      <span className="text-muted-foreground">
                        +{p.downstream_tlas.length - 12} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
    </Loadable>
  );
}

export function TreePage() {
  const { path, name } = useProjectPath();
  const splat = useParams()['*'] ?? '';
  const { ref, path: dir, ready, refs } = useRefPath(path, splat);
  if (!ready) return <Spinner />;
  return (
    <RepoBrowser
      projectPath={path}
      projectName={name}
      gitRef={ref}
      path={dir}
      branches={refs?.branches ?? []}
      tags={refs?.tags ?? []}
    />
  );
}

export function BlobPage() {
  const { path, name } = useProjectPath();
  const splat = useParams()['*'] ?? '';
  const { ref, path: file, ready, refs } = useRefPath(path, splat);
  const blob = useQuery({
    queryKey: ['file', path, ref, file],
    queryFn: () => api.getFile(path, file, ref),
    enabled: ready && Boolean(file),
  });
  if (!ready) return <Spinner />;
  const rawUrl = `${BASE_PATH}/api/v4/projects/${encodeURIComponent(path)}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher
          current={ref}
          branches={refs?.branches ?? []}
          tags={refs?.tags ?? []}
          hrefFor={(r) => `/${path}/-/blob/${r}/${file}`}
        />
        <PathCrumbs projectPath={path} projectName={name} gitRef={ref} path={file} />
      </div>
      <Loadable query={blob}>
        {(f) => (
          <Section
            title={
              <span className="inline-flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-xs">{f.file_name}</span>
                <span className="font-normal text-muted-foreground text-xs">
                  {f.size.toLocaleString()} B
                </span>
              </span>
            }
            actions={
              <>
                <Button asChild variant="outline" size="sm">
                  <Link to={commitsHref(path, ref, file)}>History</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href={rawUrl}>Raw</a>
                </Button>
                <CopyButton text={f.content} label="Copy file contents" />
              </>
            }
          >
            {f.file_name.toLowerCase().endsWith('.md') ? (
              <div className="px-6 py-5">
                <Markdown source={f.content} />
              </div>
            ) : (
              <CodeBlock
                code={f.content.replace(/\n$/, '')}
                path={f.file_path}
                className="py-2 text-[13px] [&_td:first-child]:border-r-0 [&_td:first-child]:text-gl-gray-500"
              />
            )}
          </Section>
        )}
      </Loadable>
    </div>
  );
}

export function CommitsPage() {
  const { path } = useProjectPath();
  const splat = useParams()['*'] ?? '';
  const [params] = useSearchParams();
  const filePath = params.get('path') ?? undefined;
  const { ref, ready, refs } = useRefPath(path, splat);
  const commits = useInfiniteQuery({
    queryKey: ['commits', path, ref, filePath ?? ''],
    queryFn: ({ pageParam }) =>
      api.listCommits(path, {
        ref_name: ref,
        path: filePath,
        limit: 40,
        cursor: pageParam || undefined,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: ready,
    refetchInterval: 10_000,
  });
  if (!ready) return <Spinner />;
  return (
    <div className="grid gap-4">
      <PageTitle>Commits</PageTitle>
      <div className="flex flex-wrap items-center gap-3">
        <RefSwitcher
          current={ref}
          branches={refs?.branches ?? []}
          tags={refs?.tags ?? []}
          hrefFor={(r) => commitsHref(path, r, filePath)}
        />
        {filePath && (
          <span className={cn(codeChip, 'h-7 gap-1.5 pr-0.5')}>
            {filePath}
            <Button asChild variant="ghost" size="icon-xs" aria-label="Clear path filter">
              <Link to={commitsHref(path, ref)}>
                <X />
              </Link>
            </Button>
          </span>
        )}
      </div>
      {commits.isPending ? (
        <Spinner />
      ) : commits.isError ? (
        <ErrorState error={commits.error} />
      ) : (
        <>
          <CommitList commits={commits.data.pages.flatMap((p) => p.items)} />
          <LoadMore
            hasMore={commits.hasNextPage}
            loading={commits.isFetchingNextPage}
            onClick={() => void commits.fetchNextPage()}
          />
        </>
      )}
    </div>
  );
}

export function CommitPage() {
  const { path } = useProjectPath();
  const { sha = '' } = useParams();
  const commit = useQuery({
    queryKey: ['commit', path, sha],
    queryFn: () => api.getCommit(path, sha),
  });
  return (
    <Loadable query={commit}>
      {(c) => {
        const body = c.message.split('\n').slice(1).join('\n').trim();
        return (
          <div className="grid gap-5">
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2 border-b pb-3 text-muted-foreground text-xs">
                <span className="font-semibold text-gl-strong">Commit</span>
                <code className={codeChip}>{c.id.slice(0, 8)}</code>
                <CopyButton text={c.id} label="Copy commit SHA" />
                <span>
                  authored <RelativeTime value={c.authored_date} /> by
                </span>
                <UserLink user={{ username: c.author_username, name: c.author_name }} avatar />
                <Button asChild variant="outline" size="sm" className="ml-auto">
                  <Link to={treeHref(path, c.id)}>
                    <FolderOpen data-icon="inline-start" />
                    Browse files
                  </Link>
                </Button>
              </div>
              <div>
                <h1 className="font-semibold text-2xl text-gl-strong">{c.title}</h1>
                {body && (
                  <pre className="mt-2 whitespace-pre-wrap font-mono text-[13px] text-foreground">
                    {body}
                  </pre>
                )}
              </div>
              <Card className="gap-0 divide-y py-0 ring-border">
                <div className="flex flex-wrap items-center gap-1.5 bg-gl-subtle px-4 py-2.5 text-xs">
                  <span className="text-muted-foreground">
                    {c.parent_ids.length > 1 ? `${c.parent_ids.length} parents` : '1 parent'}
                  </span>
                  {c.parent_ids.map((p) => (
                    <ShortSha key={p} projectPath={path} sha={p} />
                  ))}
                </div>
                {c.merge_request_iid ? (
                  <div className="flex items-center gap-1.5 px-4 py-2.5 text-xs">
                    <GitMerge className="size-4 text-muted-foreground" />
                    {c.parent_ids.length > 1 ? 'Merged in' : 'Part of'} merge request
                    <Link to={mrHref(path, c.merge_request_iid)} className={glLink}>
                      !{c.merge_request_iid}
                    </Link>
                  </div>
                ) : null}
              </Card>
            </div>
            <DiffView diffs={c.diffs} projectPath={path} viewRef={c.id} />
          </div>
        );
      }}
    </Loadable>
  );
}

export function BranchesPage() {
  const { path } = useProjectPath();
  const branches = useQuery({
    queryKey: ['branches', path],
    queryFn: () => api.listBranches(path, { limit: 100 }),
    refetchInterval: 10_000,
  });
  return (
    <div className="grid gap-4">
      <PageTitle>Branches</PageTitle>
      <Loadable query={branches}>
        {(page) => (
          <Section title="Active branches">
            <ul className="divide-y">
              {page.items.map((b) => (
                <li key={b.name} className="flex items-center gap-3 px-4 py-3">
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/${path}/-/tree/${b.name}`}
                        className="font-mono font-semibold text-[13px] text-gl-link hover:underline"
                      >
                        {b.name}
                      </Link>
                      {b.default && <GlBadge variant="info">default</GlBadge>}
                      {b.protected && <GlBadge variant="success">protected</GlBadge>}
                      {b.merged && <GlBadge variant="info">merged</GlBadge>}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 truncate text-muted-foreground text-xs">
                      <ShortSha projectPath={path} sha={b.commit.id} />
                      <span className="truncate">{b.commit.title}</span>
                      <span>·</span>
                      <RelativeTime value={b.commit.committed_date} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </Loadable>
    </div>
  );
}

export function TagsPage() {
  const { path } = useProjectPath();
  const selected = useParams().tag;
  const tags = useQuery({
    queryKey: ['tags', path],
    queryFn: () => api.listTags(path, { limit: 100 }),
  });
  return (
    <div className="grid gap-4">
      <PageTitle>Tags</PageTitle>
      <Loadable query={tags}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No tags yet" icon={<TagIcon />} />
          ) : (
            <Card className="gap-0 py-0 ring-border">
              <ul className="divide-y">
                {page.items.map((t) => (
                  <li
                    key={t.name}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3',
                      t.name === selected && 'bg-warning/10',
                    )}
                  >
                    <TagIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/${path}/-/tree/${t.name}`}
                        className="font-mono font-semibold text-[13px] text-gl-link hover:underline"
                      >
                        {t.name}
                      </Link>
                      <div className="mt-1 flex items-center gap-1.5 truncate text-muted-foreground text-xs">
                        <ShortSha projectPath={path} sha={t.target} />
                        <span className="truncate">{t.commit.title}</span>
                        <span>·</span>
                        <span>{dayLabel(t.created_at)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )
        }
      </Loadable>
    </div>
  );
}
