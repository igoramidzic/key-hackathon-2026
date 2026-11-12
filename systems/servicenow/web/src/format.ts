import { STANDUP } from '@sim/contracts/servicenow';

const pad = (n: number) => String(n).padStart(2, '0');

/** Outage duration on a form: "2 h 05 min" or "14 min". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  return hours > 0 ? `${hours} h ${pad(total % 60)} min` : `${total} min`;
}

/** Duration as the Critical Incident Communication email writes it: "00 Hours, 25 Minutes." */
export function formatEmailDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${pad(Math.floor(total / 60))} Hours, ${pad(total % 60)} Minutes.`;
}

/** Time as the email writes it: "10/23 7:00 AM ET" (month/day, 12-hour clock, Eastern). */
export function formatEasternTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STANDUP.time_zone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')} ${part('dayPeriod')} ET`;
}

/** A stand-up date (YYYY-MM-DD, Eastern) in words: "Friday, November 13, 2026" or "Fri, Nov 13". */
export function formatStandupDate(date: string, style: 'long' | 'short' = 'long'): string {
  const day = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  return day.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: style,
    month: style,
    day: 'numeric',
    year: style === 'long' ? 'numeric' : undefined,
  });
}
