import type { Commit, GitlabEvent, MergeRequest } from '@sim/contracts/gitlab';
import { cn, EmptyState, RelativeTime, UserAvatar } from '@sim/ui';
import {
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MessageSquare,
  Tag,
  ThumbsUp,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { commitHref, mrHref, treeHref } from '../lib/api';
import {
  CopyButton,
  dayLabel,
  glLink,
  LabelChip,
  PipelineIcon,
  refChip,
  ShortSha,
  StateBadge,
  UserLink,
} from './common';

const titleLink = 'font-semibold text-gl-strong hover:text-gl-link hover:underline';

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

export function MrRow({ mr, showProject }: { mr: MergeRequest; showProject?: boolean }) {
  return (
    <li className="flex items-start gap-3 border-b px-4 py-3 transition-colors hover:bg-gl-subtle">
      <div className="min-w-0 flex-1">
        <Link to={mrHref(mr.project_path, mr.iid)} className={cn('text-xs', titleLink)}>
          {mr.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-muted-foreground text-xs">
          {showProject ? (
            <Link to={`/${mr.project_path}`} className="hover:text-gl-link hover:underline">
              {mr.references.full}
            </Link>
          ) : (
            <span>{mr.references.short}</span>
          )}
          <span>·</span>
          <span>
            created <RelativeTime value={mr.created_at} /> by
          </span>
          <UserLink user={mr.author} className="font-normal text-muted-foreground" />
          <span className="ml-1 inline-flex items-center gap-1">
            <GitBranch className="size-3.5" />
            <span className="font-mono text-[13px]">{mr.source_branch}</span>
          </span>
          {mr.labels.length > 0 && (
            <span className="ml-1 inline-flex flex-wrap gap-1">
              {mr.labels.map((l) => (
                <LabelChip key={l} name={l} />
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 text-muted-foreground text-xs">
        <div className="flex items-center gap-3">
          {mr.state !== 'opened' && <StateBadge state={mr.state} />}
          <PipelineIcon status={mr.pipeline.status} />
          {mr.approved_by.length > 0 && (
            <span className="inline-flex items-center gap-1 text-positive" title="Approved">
              <ThumbsUp className="size-3.5" />
              {mr.approved_by.length}
            </span>
          )}
          <span className="inline-flex items-center gap-1 tabular-nums" title="Comments">
            <MessageSquare className="size-3.5" />
            {mr.user_notes_count}
          </span>
        </div>
        <span>
          updated <RelativeTime value={mr.updated_at} />
        </span>
      </div>
    </li>
  );
}

export function MrList({
  items,
  showProject,
  empty,
}: {
  items: MergeRequest[];
  showProject?: boolean;
  empty?: string;
}) {
  if (items.length === 0)
    return <EmptyState title={empty ?? 'No merge requests'} icon={<GitPullRequestArrow />} />;
  return (
    <ul>
      {items.map((mr) => (
        <MrRow key={mr.id} mr={mr} showProject={showProject} />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export function CommitRow({ commit }: { commit: Commit }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <UserAvatar name={commit.author_name} size="md" />
      <div className="min-w-0 flex-1">
        <Link
          to={commitHref(commit.project_path, commit.id)}
          className={cn('block truncate', titleLink)}
        >
          {commit.title}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
          <UserLink
            user={{ username: commit.author_username, name: commit.author_name }}
            className="font-normal text-muted-foreground"
          />
          <span>
            authored <RelativeTime value={commit.authored_date} />
          </span>
          {commit.merge_request_iid ? (
            <>
              <span>·</span>
              <Link to={mrHref(commit.project_path, commit.merge_request_iid)} className={glLink}>
                !{commit.merge_request_iid}
              </Link>
            </>
          ) : null}
        </div>
      </div>
      {commit.stats && (
        <span className="font-mono text-[12px] tabular-nums">
          <span className="text-positive">+{commit.stats.additions}</span>{' '}
          <span className="text-negative">−{commit.stats.deletions}</span>
        </span>
      )}
      <span className="flex items-center gap-1">
        <ShortSha projectPath={commit.project_path} sha={commit.id} />
        <CopyButton text={commit.id} label="Copy commit SHA" />
      </span>
    </li>
  );
}

/** Commits grouped by day, like GitLab's commit list. */
export function CommitList({ commits }: { commits: Commit[] }) {
  if (commits.length === 0) return <EmptyState title="No commits" icon={<GitCommitHorizontal />} />;
  const groups: { day: string; items: Commit[] }[] = [];
  for (const c of commits) {
    const day = dayLabel(c.committed_date);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(c);
    else groups.push({ day, items: [c] });
  }
  return (
    <div className="grid gap-4">
      {groups.map((g) => (
        <div key={g.day} className="overflow-hidden rounded-(--radius) border">
          <div className="flex items-center gap-2 border-b bg-gl-subtle px-4 py-2.5 text-xs">
            <span className="font-semibold text-gl-strong">{g.day}</span>
            <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[12px] text-muted-foreground">
              {g.items.length} commit{g.items.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="divide-y">
            {g.items.map((c) => (
              <CommitRow key={c.id} commit={c} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function eventIcon(e: GitlabEvent): ReactNode {
  const c = 'size-3.5';
  switch (e.action_name) {
    case 'merged':
      return <GitMerge className={`${c} text-chart-1`} />;
    case 'opened':
    case 'reopened':
      return <GitPullRequestArrow className={`${c} text-positive`} />;
    case 'closed':
      return <GitPullRequestClosed className={`${c} text-negative`} />;
    case 'commented on':
      return <MessageSquare className={c} />;
    default:
      return e.push_data?.ref_type === 'tag' ? (
        <Tag className={c} />
      ) : (
        <GitCommitHorizontal className={c} />
      );
  }
}

function EventBody({ e }: { e: GitlabEvent }) {
  const project = (
    <Link to={`/${e.project_path}`} className={glLink}>
      {e.project_path.replace(/^keybank\//, '')}
    </Link>
  );
  if (e.target_type === 'MergeRequest' && e.target_iid) {
    return (
      <>
        <span className="text-muted-foreground">{e.action_name} merge request </span>
        <Link to={mrHref(e.project_path, e.target_iid)} className={glLink}>
          !{e.target_iid}
        </Link>
        <span className="text-muted-foreground"> in </span>
        {project}
        <div className="mt-0.5 truncate text-muted-foreground">{e.target_title}</div>
      </>
    );
  }
  if (e.push_data) {
    const isTag = e.push_data.ref_type === 'tag';
    return (
      <>
        <span className="text-muted-foreground">
          {e.action_name} {isTag ? 'tag' : 'branch'}{' '}
        </span>
        <Link
          to={isTag ? `/${e.project_path}/-/tags` : treeHref(e.project_path, e.push_data.ref)}
          className={refChip}
        >
          {e.push_data.ref}
        </Link>
        <span className="text-muted-foreground"> at </span>
        {project}
        {!isTag && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <ShortSha projectPath={e.project_path} sha={e.push_data.commit_to} />
            <span className="truncate text-muted-foreground">{e.push_data.commit_title}</span>
          </div>
        )}
      </>
    );
  }
  return <span className="text-muted-foreground">{e.action_name}</span>;
}

export function EventFeed({ events }: { events: GitlabEvent[] }) {
  if (events.length === 0) return <EmptyState title="No activity yet" />;
  return (
    <ul className="divide-y">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3 px-4 py-3 text-xs">
          <UserAvatar name={e.author.name} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <UserLink user={e.author} />
              <span className="text-muted-foreground">@{e.author.username}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
                {eventIcon(e)}
                <RelativeTime value={e.created_at} />
              </span>
            </div>
            <div className="mt-0.5 min-w-0">
              <EventBody e={e} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
