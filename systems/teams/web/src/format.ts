import type { Presence } from '@sim/contracts/teams';

export const BOT_USERNAME = 'svc_incident_auto';

const PRESENCE_LABEL: Record<Presence, string> = {
  available: 'Available',
  busy: 'Busy',
  away: 'Away',
  offline: 'Offline',
};

export const presenceLabel = (p: Presence) => PRESENCE_LABEL[p];

/** Teams-style message timestamp: "10:42 AM", "Yesterday 3:15 PM", "Mon 9:02 AM", "11/2 4:10 PM". */
export function messageTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** Running time of a call as a clock: `0:07`, `12:45`, `1:02:09`. */
export function elapsedClock(sinceIso: string, now = Date.now()): string {
  const total = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
