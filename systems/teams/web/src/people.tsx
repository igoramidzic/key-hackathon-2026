import type { Presence } from '@sim/contracts/teams';
import { cn, initials, StatusDot, type Tone, UserAvatar } from '@sim/ui';
import { Bot } from 'lucide-react';
import { BOT_USERNAME, presenceLabel } from './format';

const PRESENCE_TONE: Record<Presence, Tone> = {
  available: 'positive',
  busy: 'negative',
  away: 'warning',
  offline: 'neutral',
};

type Size = 'xs' | 'sm' | 'md' | 'lg';

const BOX: Record<Size, string> = {
  xs: 'size-5',
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-10',
};

/** Person avatar with an optional presence dot; the automation bot gets a bot glyph. */
export function PersonAvatar({
  name,
  username,
  presence,
  size = 'md',
  className,
}: {
  name: string;
  username?: string;
  presence?: Presence;
  size?: Size;
  className?: string;
}) {
  const isBot = username === BOT_USERNAME;
  const dotSize = size === 'lg' ? 'size-2.5' : 'size-2';
  return (
    <span className={cn('relative inline-flex h-fit shrink-0', className)}>
      {isBot ? (
        <span
          title={name}
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground',
            BOX[size],
          )}
        >
          <Bot className={size === 'lg' || size === 'md' ? 'size-4' : 'size-3'} />
        </span>
      ) : (
        <UserAvatar name={name} size={size} />
      )}
      {presence && (
        <span
          title={presenceLabel(presence)}
          className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full ring-2 ring-card"
        >
          <StatusDot
            tone={PRESENCE_TONE[presence]}
            className={cn(
              dotSize,
              'rounded-full',
              presence === 'offline' && 'bg-card ring-1 ring-muted-foreground ring-inset',
            )}
          />
        </span>
      )}
    </span>
  );
}

/** Tinted tile colors for team avatars (background, text), picked by a hash of the name. */
const TEAM_TILES = [
  'bg-[#e8ebfa] text-[#444791]',
  'bg-[#fdf3f4] text-[#a4262c]',
  'bg-[#fff4ce] text-[#835c00]',
  'bg-[#e0f2ef] text-[#00666d]',
  'bg-[#f1e4f7] text-[#7a3d93]',
  'bg-[#fde7d9] text-[#8a3707]',
  'bg-[#e1efe1] text-[#0b5a08]',
  'bg-[#deecf9] text-[#004e8c]',
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Teams' rounded-square team tile: tinted background with the team's initials. */
export function TeamAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] font-semibold',
        TEAM_TILES[hash(name) % TEAM_TILES.length],
        size === 'sm' && 'size-6 text-[10px]',
        size === 'md' && 'size-8 text-[12px]',
        size === 'lg' && 'size-10 text-[14px]',
      )}
    >
      {initials(name.replace(/&/g, ''))}
    </span>
  );
}
