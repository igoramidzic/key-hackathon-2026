import { URLS } from '@sim/contracts';
import type { Channel, ChannelMember, Message, MessageImportance } from '@sim/contracts/teams';
import { Button, cn, ErrorState, RelativeTime, Spinner } from '@sim/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  AtSign,
  ExternalLink,
  Hash,
  Reply,
  SendHorizontal,
  Siren,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api, keys, useAllChannels, useChannel, useMessages, useUser } from './api';
import { BOT_USERNAME, dayLabel, messageTime } from './format';
import { Markdown, type MarkdownEnv, MarkdownEnvProvider } from './Markdown';
import { PersonAvatar, TeamAvatar } from './people';
import { useViewer } from './viewer';

export function ChannelPage({ id }: { id: string }) {
  const channel = useChannel(id);
  const messages = useMessages(id);
  const channels = useAllChannels();
  const { username: viewer, link } = useViewer();
  const [showMembers, setShowMembers] = useState(false);

  // Names for @mentions: channel members and authors, plus a lookup for anyone else mentioned.
  const known = useMemo(() => {
    const names = new Map<string, string>();
    for (const m of channel.data?.members ?? []) names.set(m.username, m.name);
    for (const m of messages.data?.items ?? []) names.set(m.author.username, m.author.name);
    return names;
  }, [channel.data, messages.data]);
  const missing = useMemo(() => {
    const out = new Set<string>();
    for (const m of messages.data?.items ?? []) {
      for (const u of m.mentions) if (!known.has(u)) out.add(u);
    }
    return [...out].sort();
  }, [messages.data, known]);
  const others = useQuery({
    queryKey: ['users-by-name', missing],
    queryFn: () => api.listUsers({ usernames: missing, limit: 100 }),
    enabled: missing.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const env = useMemo<MarkdownEnv>(() => {
    const names = new Map(known);
    for (const u of others.data?.items ?? []) names.set(u.username, u.name);
    const channelIds = new Map((channels.data?.items ?? []).map((c) => [c.name, c.id]));
    return { names, channels: channelIds, viewer, link };
  }, [known, others.data, channels.data, viewer, link]);

  if (channel.error) {
    return (
      <div className="px-4 py-5 md:px-6 md:py-6">
        <ErrorState error={channel.error} />
      </div>
    );
  }
  if (!channel.data) return <Spinner label="Loading channel" />;

  return (
    <MarkdownEnvProvider value={env}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChannelHeader
          channel={channel.data}
          showMembers={showMembers}
          onToggleMembers={() => setShowMembers((v) => !v)}
        />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <MessageList channel={channel.data} messages={messages.data?.items} />
            <div className="shrink-0 px-4 pt-1 pb-4 md:px-6">
              <div className="mx-auto max-w-[1040px]">
                <Composer channel={channel.data} />
              </div>
            </div>
          </div>
          {showMembers && (
            <MembersPanel channel={channel.data} onClose={() => setShowMembers(false)} />
          )}
        </div>
      </div>
    </MarkdownEnvProvider>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ChannelHeader({
  channel,
  showMembers,
  onToggleMembers,
}: {
  channel: Channel;
  showMembers: boolean;
  onToggleMembers: () => void;
}) {
  const people = channel.members.filter((m) => m.username !== BOT_USERNAME);
  return (
    <header className="shrink-0 border-b bg-card">
      <div className="flex h-[60px] items-center gap-3 px-4 md:px-5">
        <TeamAvatar name={channel.team_name} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1
              className="truncate font-semibold text-[18px] leading-tight"
              title={channel.description || channel.name}
            >
              {channel.display_name}
            </h1>
            {channel.incident_number && (
              <a
                href={`${URLS.servicenow.web}/incidents/${channel.incident_number}`}
                target="_blank"
                rel="noreferrer"
                title="Open the incident in ServiceNow"
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-negative/10 px-2 font-semibold text-[11px] text-negative outline-none hover:bg-negative/15 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Siren className="size-3" />
                {channel.incident_number}
                <ExternalLink className="size-3 opacity-70" />
              </a>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="shrink-0">{channel.team_name}</span>
            <span aria-hidden="true">›</span>
            <span className="shrink-0">#{channel.name}</span>
            {channel.description && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate" title={channel.description}>
                  {channel.description}
                </span>
              </>
            )}
          </div>
        </div>
        <nav aria-label="Channel tabs" className="ml-2 hidden h-full items-stretch lg:flex">
          <span
            aria-current="page"
            className="relative flex items-center px-3 font-semibold text-[14px] text-foreground"
          >
            Posts
            <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-primary" />
          </span>
          <span
            title="Files aren't part of the simulation"
            className="flex cursor-default items-center px-3 text-[14px] text-muted-foreground"
          >
            Files
          </span>
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onToggleMembers}
          title="Members"
          aria-pressed={showMembers}
          className={cn(
            'flex h-8 shrink-0 items-center gap-2 rounded-[4px] border px-2 text-[14px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            showMembers ? 'border-primary/40 bg-brand-tint text-primary' : 'bg-card',
          )}
        >
          <span className="flex -space-x-1.5">
            {people.slice(0, 3).map((m) => (
              <PersonAvatar
                key={m.username}
                name={m.name}
                username={m.username}
                size="xs"
                className="rounded-full ring-2 ring-card"
              />
            ))}
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <Users className="size-4" />
            {channel.member_count}
          </span>
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface Thread {
  root: Message;
  replies: Message[];
}

function buildThreads(messages: Message[]): Thread[] {
  const threads: Thread[] = [];
  const byId = new Map<string, Thread>();
  for (const m of messages) {
    if (m.reply_to_id && byId.has(m.reply_to_id)) {
      byId.get(m.reply_to_id)!.replies.push(m);
      continue;
    }
    const thread = { root: m, replies: [] };
    threads.push(thread);
    byId.set(m.id, thread);
  }
  return threads;
}

function MessageList({ channel, messages }: { channel: Channel; messages?: Message[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const handledHash = useRef<string | null>(null);
  const location = useLocation();
  const threads = useMemo(() => buildThreads(messages ?? []), [messages]);
  const { username: viewer } = useViewer();
  const count = messages?.length ?? 0;
  const last = messages?.at(-1);

  // Stick to the bottom as messages arrive (unless the reader scrolled up, or a deep link to a
  // message is pending). Always follow your own new posts.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !last) return;
    const hash = location.hash.slice(1);
    if (hash && handledHash.current !== hash) return;
    if (nearBottom.current || last.author.username === viewer) el.scrollTop = el.scrollHeight;
  }, [last, location.hash, viewer]);

  // Deep link to a message (from Activity): scroll to it once and flash it.
  useEffect(() => {
    const hash = location.hash.slice(1);
    if (!hash || handledHash.current === hash || !count) return;
    const target = document.getElementById(hash);
    if (!target) return;
    handledHash.current = hash;
    target.scrollIntoView({ block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }, [location.hash, count]);

  if (!messages) return <Spinner className="flex-1 items-start" />;

  let lastDay = '';
  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"
    >
      <div className="mx-auto max-w-[1040px] space-y-3">
        <ChannelIntro channel={channel} />
        {threads.map((thread) => {
          const day = dayLabel(thread.root.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={thread.root.id}>
              {showDay && <DayDivider label={day} />}
              {thread.root.kind === 'system' ? (
                <SystemLine message={thread.root} />
              ) : (
                <ThreadCard thread={thread} channel={channel} />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function ChannelIntro({ channel }: { channel: Channel }) {
  return (
    <div className="flex flex-col items-center px-6 pt-8 pb-4 text-center">
      <div
        className={cn(
          'mb-3 flex size-12 items-center justify-center rounded-[8px]',
          channel.incident_number ? 'bg-negative/10 text-negative' : 'bg-brand-tint text-primary',
        )}
      >
        {channel.incident_number ? <Siren className="size-6" /> : <Hash className="size-6" />}
      </div>
      <div className="font-semibold text-[16px]">Welcome to {channel.display_name}</div>
      {channel.description && (
        <div className="mt-1 max-w-xl text-[14px] text-muted-foreground">{channel.description}</div>
      )}
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[12px] text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      {label}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function SystemLine({ message }: { message: Message }) {
  const removed = /\b(removed|left)\b/.test(message.body);
  const created = /created the channel/.test(message.body);
  const Icon = created ? Hash : removed ? UserMinus : UserPlus;
  return (
    <div
      id={message.id}
      className="flex items-center justify-center gap-1.5 rounded-[4px] px-4 py-0.5 text-center text-[12px] text-muted-foreground"
    >
      <Icon className="size-3.5 shrink-0" />
      <span>{message.body}</span>
      <span className="shrink-0 tabular-nums">{messageTime(message.created_at)}</span>
    </div>
  );
}

const IMPORTANCE: Record<Exclude<MessageImportance, 'normal'>, { label: string }> = {
  high: { label: 'IMPORTANT!' },
  urgent: { label: 'URGENT!' },
};

function ThreadCard({ thread, channel }: { thread: Thread; channel: Channel }) {
  const { username: viewer } = useViewer();
  const [replying, setReplying] = useState(false);
  const { root, replies } = thread;
  const mentionsMe =
    root.mentions.includes(viewer) || replies.some((r) => r.mentions.includes(viewer));
  const importance = root.importance !== 'normal' ? IMPORTANCE[root.importance] : null;
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[6px] bg-card shadow-fluent-2',
        // Teams marks important posts, and posts that mention you, with a bar down the left edge.
        (importance || mentionsMe) &&
          'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        importance ? 'before:bg-negative' : mentionsMe && 'before:bg-primary',
      )}
    >
      {mentionsMe && (
        <span
          title="Mentions you"
          className="absolute top-3 right-3 inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <AtSign className="size-3" strokeWidth={2.5} />
        </span>
      )}
      <MessageRow message={root} size="md" importanceLabel={importance?.label} />
      {replies.length > 0 && (
        <div className="border-t">
          <div className="px-4 pt-2 pl-[60px] text-[12px] text-primary">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </div>
          {replies.map((r) => (
            <MessageRow key={r.id} message={r} size="sm" />
          ))}
        </div>
      )}
      <div className="border-t px-4 py-1.5 pl-[60px]">
        {replying ? (
          <div className="py-1.5">
            <Composer channel={channel} replyTo={root} compact onDone={() => setReplying(false)} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="-ml-1.5 inline-flex h-7 items-center gap-1.5 rounded-[4px] px-1.5 text-[13px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Reply className="size-4" /> Reply
          </button>
        )}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  size,
  importanceLabel,
}: {
  message: Message;
  size: 'sm' | 'md';
  importanceLabel?: string;
}) {
  return (
    <div
      id={message.id}
      className={cn('flex gap-3', size === 'md' ? 'px-4 pt-3.5 pb-2.5' : 'py-2 pr-4 pl-[60px]')}
    >
      <PersonAvatar
        name={message.author.name}
        username={message.author.username}
        size={size === 'md' ? 'md' : 'sm'}
        className={size === 'md' ? 'mt-0.5' : ''}
      />
      <div className="min-w-0 flex-1 pr-8">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[14px]">{message.author.name}</span>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {messageTime(message.created_at)}
          </span>
        </div>
        {importanceLabel && (
          <div className="mt-0.5 flex items-center gap-1 font-bold text-[12px] text-negative tracking-wide">
            <AlertCircle className="size-3.5" strokeWidth={2.5} /> {importanceLabel}
          </div>
        )}
        <Markdown body={message.body} mentions={message.mentions} className="mt-0.5" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

const NEXT_IMPORTANCE: Record<MessageImportance, MessageImportance> = {
  normal: 'high',
  high: 'urgent',
  urgent: 'normal',
};

function Composer({
  channel,
  replyTo,
  compact,
  onDone,
}: {
  channel: Channel;
  replyTo?: Message;
  compact?: boolean;
  onDone?: () => void;
}) {
  const { username: viewer } = useViewer();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [importance, setImportance] = useState<MessageImportance>('normal');
  const [selected, setSelected] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const me = useUser(viewer).data;

  // Inline reply boxes open focused.
  useEffect(() => {
    if (compact) ref.current?.focus();
  }, [compact]);

  const post = useMutation({
    mutationFn: () =>
      api.postMessage(channel.id, {
        author: viewer,
        body: text,
        importance: replyTo ? undefined : importance,
        reply_to_id: replyTo?.id,
      }),
    onSuccess: () => {
      setText('');
      setImportance('normal');
      void queryClient.invalidateQueries({ queryKey: keys.messages(channel.id) });
      void queryClient.invalidateQueries({ queryKey: keys.channels });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onDone?.();
    },
  });

  // Mention autocomplete: "@pri" before the caret.
  const query = useMemo(() => {
    const match = text.slice(0, caret).match(/(?:^|\s)@([\w.-]*)$/);
    return match ? match[1]!.toLowerCase() : null;
  }, [text, caret]);
  const candidates = useMemo(() => {
    if (query === null) return [];
    return channel.members
      .filter((m) => m.username !== BOT_USERNAME && m.username !== viewer)
      .filter((m) => m.username.startsWith(query) || m.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [query, channel.members, viewer]);

  const insertMention = (member: ChannelMember) => {
    const before = text.slice(0, caret).replace(/@([\w.-]*)$/, `@${member.username} `);
    const next = before + text.slice(caret);
    setText(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  };

  // Auto-grow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = () => {
    if (text.trim() && !post.isPending) post.mutate();
  };

  return (
    <div className="relative">
      {candidates.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-80 overflow-hidden rounded-[6px] bg-popover py-1 text-popover-foreground shadow-fluent-8">
          <div className="px-3 pt-1 pb-0.5 font-semibold text-[12px] text-muted-foreground">
            Suggestions
          </div>
          {candidates.map((m, i) => (
            <button
              type="button"
              key={m.username}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m);
              }}
              onMouseEnter={() => setSelected(i)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
                i === selected && 'bg-accent',
              )}
            >
              <PersonAvatar name={m.name} username={m.username} presence={m.presence} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">{m.name}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  @{m.username} · {m.reason ?? m.title}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          'relative overflow-hidden rounded-[6px] border bg-card transition-shadow focus-within:shadow-[inset_0_-2px_0_var(--primary)]',
          compact ? 'border-border' : 'border-transparent shadow-fluent-2',
          importance !== 'normal' && 'border-l-4 border-l-negative',
        )}
      >
        {importance !== 'normal' && (
          <div className="flex items-center gap-1 px-3 pt-2 font-bold text-[12px] text-negative tracking-wide">
            <AlertCircle className="size-3.5" strokeWidth={2.5} />
            {importance === 'urgent' ? 'URGENT!' : 'IMPORTANT!'}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setSelected(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (candidates.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((s) => (s + 1) % candidates.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((s) => (s - 1 + candidates.length) % candidates.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(candidates[selected]!);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape' && compact) onDone?.();
          }}
          placeholder={
            compact ? 'Reply' : `Start a post as ${me?.name ?? viewer}. Type @ to mention someone.`
          }
          className={cn(
            'block w-full resize-none bg-transparent px-3 text-[14px] outline-none placeholder:text-muted-foreground',
            compact ? 'py-2' : 'pt-3 pb-2',
          )}
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          {!replyTo && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setImportance((i) => NEXT_IMPORTANCE[i])}
              title="Set importance (normal → important → urgent)"
              className={cn(
                'h-7 text-[13px]',
                importance === 'normal'
                  ? 'text-muted-foreground hover:text-primary'
                  : 'text-negative hover:text-negative',
              )}
            >
              <AlertCircle data-icon="inline-start" />
              {importance === 'normal'
                ? 'Importance'
                : importance === 'high'
                  ? 'Important'
                  : 'Urgent'}
            </Button>
          )}
          {post.error && (
            <span className="truncate text-[12px] text-negative">
              {(post.error as Error).message}
            </span>
          )}
          <div className="flex-1" />
          {compact && (
            <Button size="sm" variant="ghost" onClick={onDone} className="text-[13px]">
              Cancel
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={send}
            disabled={!text.trim() || post.isPending}
            title="Send (Enter)"
            aria-label="Send"
            className="text-primary hover:bg-brand-tint hover:text-brand-hover disabled:text-subtle"
          >
            <SendHorizontal className="size-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members panel
// ---------------------------------------------------------------------------

function MembersPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { username: viewer } = useViewer();
  const owners = channel.members.filter((m) => m.role === 'owner');
  const members = channel.members.filter((m) => m.role !== 'owner');
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l bg-card">
      <div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-4">
        <div className="font-semibold text-[16px]">
          Members{' '}
          <span className="font-normal text-[14px] text-muted-foreground tabular-nums">
            ({channel.member_count})
          </span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close members">
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {[
          { label: 'Owners', list: owners },
          { label: 'Members and guests', list: members },
        ].map(
          (section) =>
            section.list.length > 0 && (
              <div key={section.label} className="mb-2">
                <div className="px-4 py-1.5 font-semibold text-[12px] text-muted-foreground">
                  {section.label} ({section.list.length})
                </div>
                {section.list.map((m) => (
                  <div key={m.username} className="flex gap-3 px-4 py-2 hover:bg-accent">
                    <PersonAvatar
                      name={m.name}
                      username={m.username}
                      presence={m.presence}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[14px]">{m.name}</span>
                        {m.username === viewer && (
                          <span className="inline-flex h-4 items-center rounded-full bg-brand-tint px-1.5 font-semibold text-[10.5px] text-primary">
                            You
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground">
                        {m.title} · @{m.username}
                      </div>
                      {m.reason && (
                        <div className="mt-1.5 rounded-[4px] border-primary border-l-2 bg-brand-tint/60 px-2 py-1 text-[12px] text-foreground leading-snug">
                          {m.reason}
                        </div>
                      )}
                      {m.added_by !== m.username && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Added by {m.added_by_name} · <RelativeTime value={m.added_at} />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ),
        )}
      </div>
    </aside>
  );
}
