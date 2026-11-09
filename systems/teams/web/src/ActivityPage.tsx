import type { Notification } from '@sim/contracts/teams';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  RelativeTime,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@sim/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, CheckCheck, Loader2, Reply, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, keys, useNotifications, useUser } from './api';
import { PersonAvatar } from './people';
import { useViewer } from './viewer';

const TYPE_ICON = {
  added_to_channel: { icon: UserPlus, label: 'Added to channel' },
  mention: { icon: AtSign, label: 'Mention' },
  reply: { icon: Reply, label: 'Reply' },
} as const;

export function ActivityPage() {
  const { username, link } = useViewer();
  const me = useUser(username);
  const notifications = useNotifications(username);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | 'unread'>('all');

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(username, ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications(username) }),
  });

  const open = (n: Notification) => {
    if (!n.read) markRead.mutate([n.id]);
    navigate(link(`/channels/${n.channel_id}${n.message_id ? `#${n.message_id}` : ''}`));
  };

  const all = notifications.data?.items ?? [];
  const unread = notifications.data?.unread_count ?? 0;
  const items = tab === 'unread' ? all.filter((n) => !n.read) : all;
  const markingAll = markRead.isPending && markRead.variables === undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <section
        aria-label="Activity feed"
        className="flex w-full shrink-0 flex-col border-r bg-pane md:w-[360px]"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
          <h1 className="font-semibold text-[18px] leading-none">Activity</h1>
          <div className="flex-1" />
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'unread')}>
            <TabsList className="h-7 rounded-full bg-transparent p-0">
              <TabsTrigger
                value="all"
                className="h-7 rounded-full px-2.5 text-[13px] data-active:bg-brand-tint data-active:text-primary"
              >
                All
              </TabsTrigger>
              <TabsTrigger
                value="unread"
                className="h-7 rounded-full px-2.5 text-[13px] data-active:bg-brand-tint data-active:text-primary"
              >
                Unread
                {unread > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 font-semibold text-[10px] text-white tabular-nums">
                    {unread}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={unread === 0 || markingAll}
            onClick={() => markRead.mutate(undefined)}
            title="Mark all as read"
            aria-label="Mark all as read"
            className="text-muted-foreground hover:text-primary"
          >
            {markingAll ? <Loader2 className="animate-spin" /> : <CheckCheck />}
          </Button>
        </div>
        <div className="truncate px-4 pb-2 text-[12px] text-muted-foreground">
          Notifications for {me.data?.name ?? username}
          {me.data ? ` · ${me.data.title}` : ''}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {notifications.error ? (
            <div className="p-2">
              <ErrorState error={notifications.error} />
            </div>
          ) : !notifications.data ? (
            <Spinner />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Bell />}
              title={tab === 'unread' ? "You're all caught up" : 'No activity yet'}
              description="When someone adds you to a channel, @mentions you or replies to you, it shows up here."
            />
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={() => open(n)} />
              ))}
            </div>
          )}
        </div>
      </section>
      <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center md:flex">
        <span className="flex size-16 items-center justify-center rounded-full bg-brand-tint text-primary">
          <Bell className="size-7" />
        </span>
        <div className="font-semibold text-[16px]">Stay on top of your incidents</div>
        <div className="max-w-sm text-[14px] text-muted-foreground">
          Pick an activity to jump straight to the post in its channel. Mentions, replies and
          channels you're added to show up here.
        </div>
      </div>
    </div>
  );
}

function NotificationRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const { icon: Icon, label } = TYPE_ICON[n.type];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'relative flex w-full gap-3 rounded-[4px] px-3 py-2.5 text-left outline-none transition-colors hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        !n.read && 'bg-card shadow-fluent-2 hover:bg-card',
      )}
    >
      {!n.read && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary"
        />
      )}
      <span className="relative mt-0.5 h-fit shrink-0">
        <PersonAvatar name={n.actor.name} username={n.actor.username} size="md" />
        <span
          title={label}
          className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-card"
        >
          <Icon className="size-2.5" strokeWidth={3} />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 break-words text-[14px] leading-snug',
              n.read ? 'text-foreground' : 'font-semibold text-foreground',
            )}
          >
            {n.title}
          </span>
          <RelativeTime
            value={n.created_at}
            className="shrink-0 text-[12px] text-muted-foreground tabular-nums"
          />
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {n.team_name} › #{n.channel_name}
          </span>
          {!n.read && <span title="Unread" className="size-2 shrink-0 rounded-full bg-primary" />}
        </span>
        <span
          className={cn(
            'mt-1 block break-words text-[13px] leading-snug',
            n.read ? 'text-muted-foreground' : 'text-foreground',
            n.type !== 'added_to_channel' && 'line-clamp-3',
          )}
        >
          {n.body}
        </span>
      </span>
    </button>
  );
}
