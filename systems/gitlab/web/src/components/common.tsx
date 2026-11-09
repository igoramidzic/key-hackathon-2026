import type { MergeRequestState, PipelineStatus, UserRef } from '@sim/contracts/gitlab';
import {
  Button,
  Card,
  CardTitle,
  cn,
  ErrorState,
  Spinner,
  StatusBadge,
  type Tone,
  UserAvatar,
} from '@sim/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  Check,
  CircleCheck,
  CircleX,
  Copy,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  LoaderCircle,
  Pause,
} from 'lucide-react';
import { marked } from 'marked';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { commitHref } from '../lib/api';

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => marked.parse(source || '', { async: false }) as string, [source]);
  if (!source.trim())
    return <p className="text-muted-foreground text-xs italic">No description provided.</p>;
  return (
    <div
      className={cn('markdown', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown from our own simulated GitLab API
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** GitLab badge variants (Pajamas): pill, 12px, tinted background with dark text. */
export type GlBadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

const GL_BADGE: Record<GlBadgeVariant, { tone: Tone; className: string }> = {
  neutral: { tone: 'neutral', className: 'bg-border text-[#535158]' },
  muted: { tone: 'neutral', className: 'bg-muted text-muted-foreground' },
  info: { tone: 'info', className: 'bg-gl-blue-100 text-gl-blue-700' },
  success: { tone: 'positive', className: 'bg-gl-green-100 text-gl-green-700' },
  warning: { tone: 'warning', className: 'bg-gl-orange-100 text-gl-orange-700' },
  danger: { tone: 'negative', className: 'bg-gl-red-100 text-gl-red-700' },
};

export function GlBadge({
  variant = 'neutral',
  children,
  className,
}: {
  variant?: GlBadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  const v = GL_BADGE[variant];
  return (
    <StatusBadge
      tone={v.tone}
      className={cn(
        'h-5 gap-1 rounded-full px-2 font-normal text-[12px] [&_svg]:size-3.5',
        v.className,
        className,
      )}
    >
      {children}
    </StatusBadge>
  );
}

const STATE_STYLE: Record<
  MergeRequestState,
  { label: string; variant: GlBadgeVariant; icon: ReactNode }
> = {
  opened: { label: 'Open', variant: 'success', icon: <GitPullRequestArrow /> },
  merged: { label: 'Merged', variant: 'info', icon: <GitMerge /> },
  closed: { label: 'Closed', variant: 'danger', icon: <GitPullRequestClosed /> },
};

export function StateBadge({ state, className }: { state: MergeRequestState; className?: string }) {
  const s = STATE_STYLE[state];
  return (
    <GlBadge variant={s.variant} className={className}>
      {s.icon}
      {s.label}
    </GlBadge>
  );
}

/** Icon color for a merge request's state (open / merged / closed). */
export const MR_STATE_TEXT: Record<MergeRequestState, string> = {
  opened: 'text-positive',
  merged: 'text-chart-1',
  closed: 'text-negative',
};

export function MrStateIcon({
  state,
  className,
}: {
  state: MergeRequestState;
  className?: string;
}) {
  const c = cn('size-4 shrink-0', MR_STATE_TEXT[state], className);
  if (state === 'merged') return <GitMerge className={c} />;
  if (state === 'closed') return <GitPullRequestClosed className={c} />;
  return <GitPullRequestArrow className={c} />;
}

export function PipelineIcon({
  status,
  className,
}: {
  status: PipelineStatus;
  className?: string;
}) {
  const c = cn('size-4 shrink-0', className);
  switch (status) {
    case 'success':
      return <CircleCheck className={cn(c, 'text-positive')} aria-label="Pipeline passed" />;
    case 'failed':
      return <CircleX className={cn(c, 'text-negative')} aria-label="Pipeline failed" />;
    case 'running':
    case 'pending':
      return (
        <LoaderCircle
          className={cn(c, 'animate-spin text-chart-1')}
          aria-label="Pipeline running"
        />
      );
    default:
      return <Pause className={cn(c, 'text-muted-foreground')} aria-label="Pipeline canceled" />;
  }
}

export const PIPELINE_LABEL: Record<PipelineStatus, string> = {
  success: 'passed',
  failed: 'failed',
  running: 'running',
  pending: 'pending',
  canceled: 'canceled',
};

/** Label colors from GitLab's suggested palette (all dark enough for white text). */
const LABEL_PALETTE = [
  '#009966',
  '#6699cc',
  '#9400d3',
  '#330066',
  '#36454f',
  '#c21e56',
  '#cc338b',
  '#cd5b45',
  '#ed9121',
  '#3cb371',
  '#428bca',
  '#5843ad',
];

const LABEL_FIXED: Record<string, string> = {
  bug: '#dc143c',
  incident: '#dc143c',
  security: '#c21e56',
  performance: '#ed9121',
  enhancement: '#009966',
  documentation: '#6699cc',
  release: '#428bca',
  dependencies: '#5843ad',
  backend: '#36454f',
};

function labelColor(name: string): string {
  if (LABEL_FIXED[name]) return LABEL_FIXED[name]!;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return LABEL_PALETTE[Math.abs(h) % LABEL_PALETTE.length]!;
}

/** GitLab label pill; scoped labels (`scope::value`) get the two-tone outlined pill. */
export function LabelChip({ name }: { name: string }) {
  const color = labelColor(name);
  const pill = 'inline-flex h-5 items-center rounded-full text-[12px] leading-none';
  const scope = name.indexOf('::');
  if (scope > 0) {
    return (
      <span className={cn(pill, 'border-2')} style={{ borderColor: color }}>
        <span
          className="flex h-full items-center pr-1.5 pl-2 text-white"
          style={{ background: color }}
        >
          {name.slice(0, scope)}
        </span>
        <span className="pr-2 pl-1.5 text-foreground">{name.slice(scope + 2)}</span>
      </span>
    );
  }
  return (
    <span className={cn(pill, 'px-2 text-white')} style={{ background: color }}>
      {name}
    </span>
  );
}

export function UserLink({
  user,
  avatar = false,
  className,
}: {
  user: Pick<UserRef, 'username' | 'name'>;
  avatar?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={`/${user.username}`}
      className={cn(
        'inline-flex items-center gap-1.5 font-semibold text-gl-strong hover:text-gl-link hover:underline',
        className,
      )}
      title={`@${user.username}`}
    >
      {avatar && <UserAvatar name={user.name} size="xs" />}
      {user.name}
    </Link>
  );
}

/** Monospace chip for refs, SHAs and paths. */
export const codeChip =
  'inline-flex items-center rounded-(--radius) bg-muted px-1.5 font-mono text-foreground text-[13px] leading-5';

/** Link color for refs, SHAs and references (GitLab's blue links). */
export const glLink = 'text-gl-link hover:underline';

/** Ref chip that links somewhere (branch names, tags): blue mono on light blue, like GitLab. */
export const refChip =
  'inline-flex items-center rounded-(--radius) bg-gl-blue-50 px-1.5 font-mono text-gl-link text-[13px] leading-5 hover:bg-gl-blue-100';

export function ShortSha({ projectPath, sha }: { projectPath: string; sha: string }) {
  return (
    <Link to={commitHref(projectPath, sha)} className={cn(codeChip, 'hover:bg-border')}>
      {sha.slice(0, 8)}
    </Link>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="icon-xs"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="text-positive" /> : <Copy />}
    </Button>
  );
}

/** GitLab's identicon palettes: a pale tint with a dark letter of the same hue. */
const IDENTICON = [
  'bg-[#fcf1ef] text-[#ae1800]',
  'bg-[#f4f0ff] text-[#5c47a6]',
  'bg-[#f1f1ff] text-[#41419f]',
  'bg-[#e9f3fc] text-[#0b5cad]',
  'bg-[#ecf4ee] text-[#24663b]',
  'bg-[#fdf1dd] text-[#8f4700]',
  'bg-[#ececef] text-[#535158]',
];

/** Rounded letter tile used for groups and projects (GitLab's identicon). */
export function EntityAvatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = {
    xs: 'size-4 text-[9px] rounded-[3px]',
    sm: 'size-6 text-[11px]',
    md: 'size-8 text-[13px]',
    lg: 'size-12 text-base',
    xl: 'size-16 text-2xl',
  };
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-(--radius) font-semibold uppercase shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]',
        IDENTICON[Math.abs(h) % IDENTICON.length],
        sizes[size],
        className,
      )}
    >
      {name.replace(/[^A-Za-z]/g, '')[0] ?? '?'}
    </span>
  );
}

/** Loading / error wrapper for a query. */
export function Loadable<T>({
  query,
  children,
  label,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  label?: string;
}) {
  if (query.isPending) return <Spinner label={label ?? 'Loading…'} />;
  if (query.isError) return <ErrorState error={query.error} />;
  return <>{children(query.data)}</>;
}

/** A card with a ruled header row (title left, controls right) over a flush body. */
export function Section({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn('gap-0 py-0 shadow-none ring-border', className)}>
      {(title || actions) && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b bg-gl-subtle px-4 py-2">
          <CardTitle className="min-w-0 truncate font-semibold text-gl-strong text-xs">
            {title}
          </CardTitle>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}

export function StackBadge({ stack }: { stack: string }) {
  const labels: Record<string, string> = {
    'java-spring': 'Java · Spring',
    'node-ts': 'TypeScript · Node',
    python: 'Python',
    'react-web': 'React',
    terraform: 'Terraform',
  };
  return <GlBadge variant="muted">{labels[stack] ?? stack}</GlBadge>;
}

/** GitLab-style underline tabs across the top of a page. */
export function TabsRow({
  label,
  children,
  actions,
}: {
  label: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b">
      <nav aria-label={label} className="flex min-w-0 overflow-x-auto [scrollbar-width:none]">
        {children}
      </nav>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2 py-2">{actions}</div>}
    </div>
  );
}

export function tabClassName(active: boolean) {
  return cn(
    'inline-flex h-12 shrink-0 items-center gap-2 px-4 text-xs transition-shadow',
    active
      ? 'font-semibold text-gl-strong shadow-[inset_0_-2px_0_0_var(--primary)]'
      : 'text-foreground hover:shadow-[inset_0_-2px_0_0_var(--border)]',
  );
}

export function TabCount({ value }: { value?: number }) {
  if (value === undefined) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 font-normal text-[12px] text-muted-foreground tabular-nums">
      {value}
    </span>
  );
}

/** GitLab page heading (`gl-heading-1`-ish). */
export function PageTitle({
  children,
  actions,
  description,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="grid min-w-0 gap-1">
        <h1 className="m-0 font-semibold text-2xl text-gl-strong">{children}</h1>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Formats an absolute date like "Nov 09, 2026". */
export function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

/** Loader icon for buttons with a pending action. */
export function ButtonSpinner() {
  return <LoaderCircle className="animate-spin" data-icon="inline-start" />;
}
