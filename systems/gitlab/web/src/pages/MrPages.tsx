import type { MergeRequestDetail, MergeRequestState, Note } from '@sim/contracts/gitlab';
import {
  Button,
  Card,
  ErrorState,
  LoadMore,
  NativeSelect,
  RelativeTime,
  Spinner,
  Textarea,
  UserAvatar,
} from '@sim/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MessageSquare,
  ThumbsUp,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  ButtonSpinner,
  CopyButton,
  codeChip,
  LabelChip,
  Loadable,
  Markdown,
  PageTitle,
  PIPELINE_LABEL,
  PipelineIcon,
  refChip,
  ShortSha,
  StateBadge,
  TabCount,
  TabsRow,
  tabClassName,
  UserLink,
} from '../components/common';
import { DiffView } from '../components/DiffView';
import { CommitList, MrList } from '../components/lists';
import {
  api,
  commitHref,
  DEFAULT_MERGERS,
  loadMergeAs,
  mrHref,
  ORG,
  saveMergeAs,
  treeHref,
} from '../lib/api';
import { useProjectPath } from '../lib/project';

type StateTab = MergeRequestState | 'all';

function MrListPage({
  title,
  load,
  queryKey,
  showProject,
}: {
  title: string;
  load: (state: StateTab, cursor?: string) => ReturnType<typeof api.listMergeRequests>;
  queryKey: unknown[];
  showProject?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') as StateTab | null) ?? 'opened';
  const list = useInfiniteQuery({
    queryKey: [...queryKey, state],
    queryFn: ({ pageParam }) => load(state, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 5_000,
  });
  const counts = useQuery({
    queryKey: [...queryKey, 'counts'],
    queryFn: async () => {
      const [opened, merged, all] = await Promise.all([
        load('opened'),
        load('merged'),
        load('all'),
      ]);
      return { opened: opened.total, merged: merged.total, all: all.total };
    },
    refetchInterval: 10_000,
  });
  return (
    <div className="grid gap-0">
      <PageTitle className="pb-2">{title}</PageTitle>
      <TabsRow label="Merge request state">
        {(
          [
            { value: 'opened', label: 'Open', count: counts.data?.opened },
            { value: 'merged', label: 'Merged', count: counts.data?.merged },
            { value: 'all', label: 'All', count: counts.data?.all },
          ] as const
        ).map((t) => (
          <button
            key={t.value}
            type="button"
            aria-current={state === t.value ? 'page' : undefined}
            onClick={() => setParams({ state: t.value })}
            className={tabClassName(state === t.value)}
          >
            {t.label}
            <TabCount value={t.count} />
          </button>
        ))}
      </TabsRow>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} />
      ) : (
        <div>
          <MrList
            items={list.data.pages.flatMap((p) => p.items)}
            showProject={showProject}
            empty={state === 'opened' ? 'No open merge requests' : 'No merge requests'}
          />
          {list.hasNextPage && (
            <LoadMore
              hasMore
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectMrsPage() {
  const { path } = useProjectPath();
  return (
    <MrListPage
      title="Merge requests"
      queryKey={['mrs', path]}
      load={(state, cursor) => api.listProjectMergeRequests(path, { state, cursor, limit: 25 })}
    />
  );
}

export function DashboardMrsPage() {
  return (
    <MrListPage
      title="Merge requests across KeyBank"
      queryKey={['mrs', 'all']}
      showProject
      load={(state, cursor) => api.listMergeRequests({ state, cursor, limit: 25 })}
    />
  );
}

// ---------------------------------------------------------------------------
// MR page
// ---------------------------------------------------------------------------

type MrTab = 'overview' | 'commits' | 'changes';

function useActors(groupPath: string, mr?: MergeRequestDetail) {
  const group = useQuery({
    queryKey: ['group', groupPath.split('/')[1]],
    queryFn: () => api.getGroup(groupPath),
  });
  const names = new Map<string, string>();
  for (const u of DEFAULT_MERGERS) names.set(u, u);
  for (const m of group.data?.members ?? []) names.set(m.username, m.name);
  if (mr) names.set(mr.author.username, mr.author.name);
  return [...names.entries()].map(([username, name]) => ({ username, name }));
}

function WidgetRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1 text-xs">{children}</div>
    </div>
  );
}

function MergeWidget({
  mr,
  projectPath,
  actor,
  setActor,
  actors,
}: {
  mr: MergeRequestDetail;
  projectPath: string;
  actor: string;
  setActor: (u: string) => void;
  actors: { username: string; name: string }[];
}) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['mr', projectPath, mr.iid] });
    void qc.invalidateQueries({ queryKey: ['project', projectPath] });
    void qc.invalidateQueries({ queryKey: ['mrs'] });
  };
  const merge = useMutation({
    mutationFn: () => api.mergeMergeRequest(projectPath, mr.iid, { merged_by: actor }),
    onSuccess: refresh,
  });
  const close = useMutation({
    mutationFn: (event: 'close' | 'reopen') =>
      api.updateMergeRequest(projectPath, mr.iid, { state_event: event, actor }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () => api.approveMergeRequest(projectPath, mr.iid, actor),
    onSuccess: refresh,
  });
  const error = merge.error ?? close.error ?? approve.error;
  const approved = mr.approved_by.some((u) => u.username === actor);
  const status = mr.pipeline.status;
  return (
    <Card data-demo="merge-widget" className="gap-0 divide-y py-0 ring-border">
      <WidgetRow icon={<PipelineIcon status={status} className="size-5" />}>
        <span className="font-medium">
          Pipeline #{mr.pipeline.id} {PIPELINE_LABEL[status]}
        </span>{' '}
        <span className="text-muted-foreground">
          for <ShortSha projectPath={projectPath} sha={mr.sha} /> on{' '}
          <Link to={treeHref(projectPath, mr.source_branch)} className={refChip}>
            {mr.source_branch}
          </Link>
        </span>
        {status === 'running' && (
          <div className="mt-0.5 text-muted-foreground">build · test · scan stages running…</div>
        )}
      </WidgetRow>
      <WidgetRow
        icon={
          <ThumbsUp
            className={
              mr.approved_by.length > 0 ? 'size-5 text-positive' : 'size-5 text-muted-foreground'
            }
          />
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {mr.approved_by.length > 0 ? (
            <span>
              Approved by{' '}
              {mr.approved_by.map((u, i) => (
                <span key={u.username}>
                  {i > 0 && ', '}
                  <UserLink user={u} />
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">Approval is optional</span>
          )}
          {mr.state === 'opened' && !approved && (
            <Button
              variant="outline"
              size="xs"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending && <ButtonSpinner />}
              Approve
            </Button>
          )}
        </div>
      </WidgetRow>
      {mr.state === 'opened' && (
        <WidgetRow
          icon={
            mr.merge_status === 'can_be_merged' ? (
              <CircleCheck className="size-5 text-positive" />
            ) : (
              <CircleX className="size-5 text-negative" />
            )
          }
        >
          {mr.merge_status === 'can_be_merged' ? (
            <div className="grid gap-2.5">
              <div className="font-semibold text-gl-strong">Ready to merge!</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  data-demo="merge-button"
                  disabled={merge.isPending}
                  onClick={() => merge.mutate()}
                >
                  {merge.isPending ? <ButtonSpinner /> : <GitMerge data-icon="inline-start" />}
                  Merge
                </Button>
                <span className="text-muted-foreground">as</span>
                <NativeSelect
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                  className="w-56"
                  aria-label="Merge as user"
                >
                  {actors.map((a) => (
                    <option key={a.username} value={a.username}>
                      {a.name === a.username ? a.username : `${a.name} (@${a.username})`}
                    </option>
                  ))}
                </NativeSelect>
                <Button
                  variant="outline"
                  className="ml-auto"
                  disabled={close.isPending}
                  onClick={() => close.mutate('close')}
                >
                  {close.isPending && <ButtonSpinner />}
                  Close merge request
                </Button>
              </div>
              <div className="text-muted-foreground">
                Merges <code className={codeChip}>{mr.source_branch}</code> into{' '}
                <code className={codeChip}>{mr.target_branch}</code> with a merge commit and deletes
                the source branch.
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-negative">
                Merge blocked: the source branch has conflicts with {mr.target_branch}.
              </span>
              <Button
                variant="outline"
                className="ml-auto"
                disabled={close.isPending}
                onClick={() => close.mutate('close')}
              >
                {close.isPending && <ButtonSpinner />}
                Close merge request
              </Button>
            </div>
          )}
        </WidgetRow>
      )}
      {mr.state === 'merged' && (
        <WidgetRow icon={<GitMerge className="size-5 text-chart-1" />}>
          <div>
            Merged by {mr.merged_by && <UserLink user={mr.merged_by} />}{' '}
            <RelativeTime value={mr.merged_at!} />
          </div>
          {mr.merge_commit_sha && (
            <div className="mt-1 text-muted-foreground">
              The changes were merged into{' '}
              <Link to={treeHref(projectPath, mr.target_branch)} className={refChip}>
                {mr.target_branch}
              </Link>{' '}
              with <ShortSha projectPath={projectPath} sha={mr.merge_commit_sha} />
            </div>
          )}
        </WidgetRow>
      )}
      {mr.state === 'closed' && (
        <WidgetRow icon={<GitPullRequestClosed className="size-5 text-negative" />}>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Closed by {mr.closed_by && <UserLink user={mr.closed_by} />}{' '}
              {mr.closed_at && <RelativeTime value={mr.closed_at} />}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={close.isPending}
              onClick={() => close.mutate('reopen')}
            >
              {close.isPending && <ButtonSpinner />}
              Reopen
            </Button>
          </div>
        </WidgetRow>
      )}
      {error && (
        <div className="px-4 py-3">
          <ErrorState error={error} />
        </div>
      )}
    </Card>
  );
}

type TimelineItem =
  | { kind: 'event'; at: string; icon: ReactNode; text: ReactNode }
  | { kind: 'note'; at: string; note: Note };

function Timeline({ mr, notes }: { mr: MergeRequestDetail; notes: Note[] }) {
  const items: TimelineItem[] = [
    {
      kind: 'event',
      at: mr.created_at,
      icon: <GitPullRequestArrow className="size-3.5 text-muted-foreground" />,
      text: (
        <>
          <UserLink user={mr.author} /> opened this merge request
        </>
      ),
    },
    ...notes.map((note) => ({ kind: 'note' as const, at: note.created_at, note })),
  ];
  if (mr.merged_at && mr.merged_by) {
    items.push({
      kind: 'event',
      at: mr.merged_at,
      icon: <GitMerge className="size-3.5 text-chart-1" />,
      text: (
        <>
          <UserLink user={mr.merged_by} /> merged this merge request
        </>
      ),
    });
  }
  if (mr.closed_at && mr.closed_by) {
    items.push({
      kind: 'event',
      at: mr.closed_at,
      icon: <GitPullRequestClosed className="size-3.5 text-negative" />,
      text: (
        <>
          <UserLink user={mr.closed_by} /> closed this merge request
        </>
      ),
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <ol className="relative grid gap-4 before:absolute before:top-2 before:bottom-2 before:left-[15.5px] before:w-px before:bg-border">
      {items.map((item, i) =>
        item.kind === 'event' ? (
          <li key={i} className="relative flex items-center gap-3 text-muted-foreground text-xs">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-gl-subtle">
              {item.icon}
            </span>
            <span>
              {item.text} <RelativeTime value={item.at} />
            </span>
          </li>
        ) : (
          <li key={item.note.id} className="relative flex gap-3">
            <UserAvatar name={item.note.author.name} size="md" className="ring-4 ring-background" />
            <Card className="min-w-0 flex-1 gap-1.5 px-4 py-3 ring-border">
              <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
                <UserLink user={item.note.author} />
                <span>@{item.note.author.username}</span>
                <span>·</span>
                <RelativeTime value={item.note.created_at} />
              </div>
              <Markdown source={item.note.body} />
            </Card>
          </li>
        ),
      )}
    </ol>
  );
}

function CommentBox({
  projectPath,
  iid,
  actor,
}: {
  projectPath: string;
  iid: number;
  actor: string;
}) {
  const [body, setBody] = useState('');
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => api.addNote(projectPath, iid, { body, author: actor }),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: ['mr-notes', projectPath, iid] });
      void qc.invalidateQueries({ queryKey: ['mr', projectPath, iid] });
    },
  });
  return (
    <div className="grid gap-2 pl-11">
      <div className="overflow-hidden rounded-(--radius) border border-gl-gray-500 focus-within:border-ring focus-within:shadow-[0_0_0_1px_#fff,0_0_0_3px_var(--ring)]">
        <div className="flex items-center gap-3 border-b bg-gl-subtle px-3 text-xs">
          <span className="py-2 font-semibold text-gl-strong shadow-[inset_0_-2px_0_0_var(--primary)]">
            Write
          </span>
          <span className="py-2 text-muted-foreground">Markdown supported</span>
        </div>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a comment or drag your files here…"
          rows={4}
          className="rounded-none border-0! shadow-none! focus-visible:ring-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={!body.trim() || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? <ButtonSpinner /> : <MessageSquare data-icon="inline-start" />}
          Comment
        </Button>
        <span className="text-muted-foreground text-xs">as @{actor}</span>
        {add.error && <span className="text-negative text-xs">{(add.error as Error).message}</span>}
      </div>
    </div>
  );
}

export function MrPage() {
  const { path, group } = useProjectPath();
  const params = useParams();
  const iid = Number(params.iid);
  const sub = params['*'] ?? '';
  const tab: MrTab = sub.startsWith('diffs')
    ? 'changes'
    : sub.startsWith('commits')
      ? 'commits'
      : 'overview';
  const [actor, setActorState] = useState(loadMergeAs);
  const setActor = (u: string) => {
    setActorState(u);
    saveMergeAs(u);
  };
  const mr = useQuery({
    queryKey: ['mr', path, iid],
    queryFn: () => api.getMergeRequest(path, iid),
    refetchInterval: 4_000,
  });
  const notes = useQuery({
    queryKey: ['mr-notes', path, iid],
    queryFn: () => api.listNotes(path, iid),
    refetchInterval: 4_000,
  });
  const changes = useQuery({
    queryKey: ['mr-changes', path, iid, mr.data?.sha],
    queryFn: () => api.getMergeRequestChanges(path, iid),
    enabled: tab === 'changes' && Boolean(mr.data),
  });
  const commits = useQuery({
    queryKey: ['mr-commits', path, iid, mr.data?.sha],
    queryFn: () => api.getMergeRequestCommits(path, iid),
    enabled: tab === 'commits' && Boolean(mr.data),
  });
  const actors = useActors(`${ORG}/${group}`, mr.data);
  return (
    <Loadable query={mr}>
      {(m) => (
        <div className="grid gap-0">
          <div className="grid gap-2 pb-2">
            <h1 data-demo="mr-title" className="font-semibold text-2xl text-gl-strong">
              {m.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
              <StateBadge state={m.state} className="mr-1" />
              <UserLink user={m.author} avatar />
              <span>requested to merge</span>
              <Link to={treeHref(path, m.source_branch)} className={refChip}>
                {m.source_branch}
              </Link>
              <span>into</span>
              <Link to={treeHref(path, m.target_branch)} className={refChip}>
                {m.target_branch}
              </Link>
              <span>
                <RelativeTime value={m.created_at} />
              </span>
            </div>
          </div>

          <TabsRow label="Merge request">
            {(
              [
                { value: 'overview', label: 'Overview', count: m.user_notes_count, sub: '' },
                { value: 'commits', label: 'Commits', count: m.commits_count, sub: '/commits' },
                { value: 'changes', label: 'Changes', count: m.changes_count, sub: '/diffs' },
              ] as const
            ).map((t) => (
              <Link
                key={t.value}
                to={`${mrHref(path, iid)}${t.sub}`}
                aria-current={tab === t.value ? 'page' : undefined}
                className={tabClassName(tab === t.value)}
              >
                {t.label}
                <TabCount value={t.count} />
              </Link>
            ))}
          </TabsRow>

          {tab === 'overview' && (
            <div className="grid lg:grid-cols-[minmax(0,1fr)_290px]">
              <div className="grid min-w-0 content-start gap-5 pt-4 lg:pr-6">
                <div data-demo="mr-description">
                  <Markdown source={m.description} />
                </div>
                <MergeWidget
                  mr={m}
                  projectPath={path}
                  actor={actor}
                  setActor={setActor}
                  actors={actors}
                />
                <div className="grid gap-4 pt-2">
                  <h2 className="border-b pb-2 font-semibold text-base text-gl-strong">Activity</h2>
                  <Loadable query={notes}>{(list) => <Timeline mr={m} notes={list} />}</Loadable>
                </div>
                <CommentBox projectPath={path} iid={iid} actor={actor} />
              </div>
              <aside
                aria-label="Merge request details"
                className="mt-6 grid content-start divide-y self-stretch border-t lg:mt-0 lg:border-t-0 lg:border-l lg:pl-5"
              >
                <SidebarBlock title="Assignee">
                  <UserLink user={m.author} avatar />
                </SidebarBlock>
                <SidebarBlock title="Reviewers">
                  {m.approved_by.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <ul className="grid gap-1.5">
                      {m.approved_by.map((u) => (
                        <li key={u.username} className="flex items-center gap-1.5">
                          <UserLink user={u} avatar />
                          <CircleCheck className="size-3.5 text-positive" aria-label="Approved" />
                        </li>
                      ))}
                    </ul>
                  )}
                </SidebarBlock>
                <SidebarBlock title="Labels">
                  {m.labels.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {m.labels.map((l) => (
                        <LabelChip key={l} name={l} />
                      ))}
                    </div>
                  )}
                </SidebarBlock>
                <SidebarBlock title="Pipeline">
                  <span className="inline-flex items-center gap-1.5">
                    <PipelineIcon status={m.pipeline.status} /> {PIPELINE_LABEL[m.pipeline.status]}
                  </span>
                </SidebarBlock>
                <SidebarBlock title="Participants">
                  <div className="flex flex-wrap gap-1">
                    {[m.author, ...m.approved_by, ...(notes.data ?? []).map((n) => n.author)]
                      .filter((u, i, all) => all.findIndex((x) => x.username === u.username) === i)
                      .map((u) => (
                        <Link key={u.username} to={`/${u.username}`} title={u.name}>
                          <UserAvatar name={u.name} size="sm" />
                        </Link>
                      ))}
                  </div>
                </SidebarBlock>
                <SidebarBlock title="Reference">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-[13px]">
                      {m.references.full}
                    </code>
                    <CopyButton text={m.web_url} label="Copy link" />
                  </span>
                </SidebarBlock>
                <SidebarBlock title="Source branch">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-[13px]">
                      {m.source_branch}
                    </code>
                    <CopyButton text={m.source_branch} label="Copy branch name" />
                  </span>
                </SidebarBlock>
                {m.merge_commit_sha && (
                  <SidebarBlock title="Merge commit">
                    <Link
                      to={commitHref(path, m.merge_commit_sha)}
                      className={`${codeChip} hover:bg-border`}
                    >
                      {m.merge_commit_sha.slice(0, 8)}
                    </Link>
                  </SidebarBlock>
                )}
              </aside>
            </div>
          )}

          {tab === 'commits' && (
            <div className="pt-4">
              <Loadable query={commits}>{(list) => <CommitList commits={list} />}</Loadable>
            </div>
          )}

          {tab === 'changes' && (
            <Loadable query={changes}>
              {(c) => (
                <DiffView
                  className="pt-4"
                  diffs={c.changes}
                  projectPath={path}
                  viewRef={c.state === 'merged' ? (c.merge_commit_sha ?? c.sha) : c.sha}
                />
              )}
            </Loadable>
          )}
        </div>
      )}
    </Loadable>
  );
}

function SidebarBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2 py-4 text-xs">
      <div className="font-semibold text-gl-strong">{title}</div>
      <div className="min-w-0 text-muted-foreground">{children}</div>
    </div>
  );
}
