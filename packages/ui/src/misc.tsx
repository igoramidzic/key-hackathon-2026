import hljs from 'highlight.js/lib/common';
import { useEffect, useMemo, useState } from 'react';
import { cn } from './cn';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function formatRelative(input: string | number | Date, now = Date.now()): string {
  const t = new Date(input).getTime();
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 10) return 'just now';
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.floor(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.floor(abs / 3600)}h ${suffix}`;
  if (abs < 86400 * 30) return `${Math.floor(abs / 86400)}d ${suffix}`;
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(input: string | number | Date): string {
  return new Date(input).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Relative time that re-renders every 15s; full timestamp on hover. */
export function RelativeTime({
  value,
  className,
}: {
  value: string | number | Date;
  className?: string;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <time
      className={className}
      dateTime={new Date(value).toISOString()}
      title={formatDateTime(value)}
    >
      {formatRelative(value)}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

/** Square initials avatar; a stable data color per name. */
const AVATAR_COLORS = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
  'bg-chart-7',
  'bg-chart-8',
];

function hashCode(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
  ).toUpperCase();
}

export function UserAvatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizes = {
    xs: 'size-5 text-[9px]',
    sm: 'size-6 text-[10px]',
    md: 'size-8 text-[11px]',
    lg: 'size-10 text-xs',
  };
  return (
    <span
      title={name}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-(--avatar-radius) font-semibold text-white',
        AVATAR_COLORS[hashCode(name) % AVATAR_COLORS.length],
        sizes[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  java: 'java',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  xml: 'xml',
  md: 'markdown',
  sql: 'sql',
  sh: 'bash',
  tf: 'ini',
  toml: 'ini',
  properties: 'properties',
  gradle: 'groovy',
  dockerfile: 'dockerfile',
  css: 'css',
  html: 'xml',
  kt: 'kotlin',
  go: 'go',
};

export function languageForPath(path: string): string | undefined {
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_LANG[ext];
}

/** Highlights one line or a whole file. Returns HTML; safe because hljs escapes input. */
export function highlight(code: string, language?: string): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
  return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** File viewer with line numbers and syntax highlighting. */
export function CodeBlock({
  code,
  path,
  language,
  className,
  highlightLines,
}: {
  code: string;
  path?: string;
  language?: string;
  className?: string;
  highlightLines?: number[];
}) {
  const lang = language ?? (path ? languageForPath(path) : undefined);
  const lines = useMemo(() => highlight(code, lang).split('\n'), [code, lang]);
  const marked = new Set(highlightLines ?? []);
  return (
    <div className={cn('overflow-x-auto font-mono text-[12.5px] leading-5', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((html, i) => (
            <tr key={i} className={cn(marked.has(i + 1) && 'bg-warning/10')}>
              <td className="w-12 select-none border-r pr-3 text-right align-top text-muted-foreground/70">
                {i + 1}
              </td>
              <td className="whitespace-pre pl-4">
                <span
                  className="hljs"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped
                  dangerouslySetInnerHTML={{ __html: html || ' ' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pretty JSON with highlighting, for payload inspectors. */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const html = useMemo(() => highlight(JSON.stringify(value, null, 2), 'json'), [value]);
  return (
    <pre className={cn('overflow-x-auto font-mono text-xs leading-5', className)}>
      <code
        className="hljs"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
