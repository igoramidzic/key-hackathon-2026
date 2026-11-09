import type { AlertSeverity, AlertStatus, Severity } from '@sim/contracts/logs';
import { createLogsClient } from '@sim/contracts/logs';
import { cn } from '@sim/ui';
import { CircleCheck, CircleDot, CircleSlash, Eye, type LucideIcon } from 'lucide-react';

/**
 * Path prefix the UI is served under: '' in multi-port dev (base '/'), '/logs' when built with
 * `vite build --base /logs/` for single-origin hosting. The REST API sits under the same prefix.
 */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Same-origin client under BASE_PATH; Vite proxies /api, /admin and /health to the logs API. */
export const api = createLogsClient(BASE_PATH);

/** The person operating the UI (NOC shift lead persona). */
export const OPERATOR = { username: 'dwhitfield', name: 'Dana Whitfield' };

// ---------------------------------------------------------------------------
// Log severities, drawn the way the Cloud console draws them: filled glyphs (red "!" circle for
// errors, "!!" for critical and above, amber triangle for warnings, blue "i" for info/notice, a
// gray asterisk for default/debug). `fill` is the histogram color.
// ---------------------------------------------------------------------------

const GCP_RED = '#d93025';
const GCP_AMBER = '#f9ab00';
const GCP_BLUE = '#1a73e8';
const GCP_GRAY = '#9aa0a6';

type Glyph = 'default' | 'debug' | 'info' | 'warning' | 'error' | 'critical';

export const SEVERITY_STYLE: Record<Severity, { glyph: Glyph; fill: string; opacity: number }> = {
  DEFAULT: { glyph: 'default', fill: GCP_GRAY, opacity: 0.55 },
  DEBUG: { glyph: 'debug', fill: GCP_GRAY, opacity: 0.85 },
  INFO: { glyph: 'info', fill: GCP_BLUE, opacity: 0.75 },
  NOTICE: { glyph: 'info', fill: GCP_BLUE, opacity: 0.9 },
  WARNING: { glyph: 'warning', fill: GCP_AMBER, opacity: 1 },
  ERROR: { glyph: 'error', fill: GCP_RED, opacity: 0.85 },
  CRITICAL: { glyph: 'critical', fill: GCP_RED, opacity: 1 },
  ALERT: { glyph: 'critical', fill: GCP_RED, opacity: 1 },
  EMERGENCY: { glyph: 'critical', fill: GCP_RED, opacity: 1 },
};

function Glyph({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case 'error':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill={GCP_RED} />
          <rect x="7.1" y="3.6" width="1.8" height="5.6" rx="0.9" fill="#fff" />
          <circle cx="8" cy="11.6" r="1.05" fill="#fff" />
        </>
      );
    case 'critical':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill={GCP_RED} />
          <rect x="4.9" y="3.6" width="1.8" height="5.6" rx="0.9" fill="#fff" />
          <circle cx="5.8" cy="11.6" r="1.05" fill="#fff" />
          <rect x="9.3" y="3.6" width="1.8" height="5.6" rx="0.9" fill="#fff" />
          <circle cx="10.2" cy="11.6" r="1.05" fill="#fff" />
        </>
      );
    case 'warning':
      return (
        <>
          <path
            d="M8 1.3c.4 0 .75.2.95.55l6.3 11.2c.4.72-.1 1.6-.93 1.6H1.68c-.82 0-1.33-.88-.93-1.6l6.3-11.2A1.1 1.1 0 0 1 8 1.3Z"
            fill={GCP_AMBER}
          />
          <rect x="7.15" y="5.2" width="1.7" height="4.6" rx="0.85" fill="#202124" />
          <circle cx="8" cy="11.9" r="0.98" fill="#202124" />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill={GCP_BLUE} />
          <circle cx="8" cy="4.6" r="1.05" fill="#fff" />
          <rect x="7.1" y="6.6" width="1.8" height="5.8" rx="0.9" fill="#fff" />
        </>
      );
    case 'debug':
      return (
        <>
          <circle cx="8" cy="8" r="6.3" fill="none" stroke={GCP_GRAY} strokeWidth="1.4" />
          <circle cx="8" cy="8" r="2.4" fill={GCP_GRAY} />
        </>
      );
    default:
      return (
        <path
          d="M8 2.5v11M3.24 5.25l9.52 5.5M3.24 10.75l9.52-5.5"
          stroke={GCP_GRAY}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      );
  }
}

export function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.DEFAULT;
  return (
    <span title={severity} className={cn('inline-flex shrink-0', className)}>
      <svg viewBox="0 0 16 16" className="size-4" aria-label={severity} role="img">
        <Glyph glyph={style.glyph} />
      </svg>
    </span>
  );
}

/** Legend swatch in a severity's histogram color. */
export function SeveritySwatch({ severity }: { severity: Severity }) {
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.DEFAULT;
  return (
    <span
      className="size-2.5 shrink-0 rounded-[2px]"
      style={{ backgroundColor: style.fill, opacity: style.opacity }}
    />
  );
}

// ---------------------------------------------------------------------------
// Moogsoft alert severities / statuses (colors are `.theme-moogsoft` tokens)
// ---------------------------------------------------------------------------

export const ALERT_SEVERITY_STYLE: Record<
  AlertSeverity,
  { label: string; color: string; text: string; rank: number }
> = {
  critical: { label: 'Critical', color: 'var(--moog-critical)', text: '#fff', rank: 5 },
  major: { label: 'Major', color: 'var(--moog-major)', text: '#fff', rank: 4 },
  minor: { label: 'Minor', color: 'var(--moog-minor)', text: '#3a2f00', rank: 3 },
  warning: { label: 'Warning', color: 'var(--moog-warning)', text: '#fff', rank: 2 },
  clear: { label: 'Clear', color: 'var(--moog-clear)', text: '#fff', rank: 1 },
};

export const ALERT_SEVERITY_ORDER: AlertSeverity[] = [
  'critical',
  'major',
  'minor',
  'warning',
  'clear',
];

export const ALERT_STATUS_STYLE: Record<
  AlertStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  open: { label: 'Open', icon: CircleDot, className: 'text-[#c0392b]' },
  acknowledged: { label: 'Acknowledged', icon: Eye, className: 'text-[#b26a00]' },
  resolved: { label: 'Resolved', icon: CircleCheck, className: 'text-positive' },
  closed: { label: 'Closed', icon: CircleSlash, className: 'text-muted-foreground' },
};

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Moogsoft's solid severity block (fills a table cell when `block`). */
export function AlertSeverityLabel({
  severity,
  block,
  className,
}: {
  severity: AlertSeverity;
  block?: boolean;
  className?: string;
}) {
  const style = ALERT_SEVERITY_STYLE[severity];
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-(--radius) font-semibold text-[12px] leading-none',
        block ? 'h-full w-full px-2' : 'h-[22px] min-w-[72px] px-2',
        className,
      )}
      style={{ backgroundColor: style.color, color: style.text }}
    >
      {style.label}
    </span>
  );
}

export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  const style = ALERT_STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 font-medium text-[12px]', style.className)}
    >
      <Icon className="size-3.5" strokeWidth={2.25} />
      {style.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2026-11-09 14:30:05.123` in local time, like the Logs Explorer timestamp column. */
export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export const formatCount = (n: number) => n.toLocaleString('en-US');

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Moogsoft-style absolute timestamp: `11/09/2026 14:30:05` (`11/09 14:30:05` when `short`). */
export function formatMoogTime(iso: string, short = false): string {
  const d = new Date(iso);
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}${short ? '' : `/${d.getFullYear()}`}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
