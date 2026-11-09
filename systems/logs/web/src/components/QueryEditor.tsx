import { cn } from '@sim/ui';
import { type KeyboardEvent, type ReactNode, useMemo, useRef } from 'react';

/** Token classes for the overlay highlighter (same token colors as the shared hljs theme). */
const TOKEN_RE =
  /(--[^\n]*)|("(?:[^"\\\n]|\\.)*"?)|(\b(?:AND|OR|NOT)\b)|(>=|<=|!=|=~|!~|[=:<>])|(\b(?:DEFAULT|DEBUG|INFO|NOTICE|WARNING|ERROR|CRITICAL|ALERT|EMERGENCY)\b)|([A-Za-z_@][\w@.-]*(?=\s*(?:>=|<=|!=|=~|!~|[=:<>])))/g;

const TOKEN_CLASS = [
  'text-muted-foreground italic', // comment
  'text-positive', // string
  'font-semibold text-chart-4', // keyword
  'text-muted-foreground', // operator
  'text-warning', // severity
  'text-chart-1', // field
];

function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(src.slice(last, index));
    const group = m.slice(1).findIndex((g) => g !== undefined);
    out.push(
      <span key={index} className={TOKEN_CLASS[group]}>
        {m[0]}
      </span>,
    );
    last = index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  // A trailing newline needs a character after it to get its own line in a <pre>.
  out.push('\n');
  return out;
}

const LINE_HEIGHT = 20;

/**
 * Monospace query editor with line numbers and syntax highlighting (a transparent textarea over
 * a highlighted <pre>). Ctrl/Cmd+Enter calls `onRun`.
 */
export function QueryEditor({
  value,
  onChange,
  onRun,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const lines = Math.max(3, value.split('\n').length);
  const highlighted = useMemo(() => highlight(value), [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRun();
    }
  };

  const shared = 'm-0 whitespace-pre border-0 py-2 pr-3 pl-1 font-mono text-[13px] [tab-size:2]';

  return (
    <div
      className={cn(
        'flex overflow-hidden rounded-(--radius) border bg-card transition-colors focus-within:ring-1',
        invalid
          ? 'border-destructive ring-1 ring-destructive focus-within:ring-destructive'
          : 'border-input hover:border-[#bdc1c6] focus-within:border-primary focus-within:ring-primary',
      )}
    >
      <div
        aria-hidden
        className="min-w-10 select-none py-2 pr-3 pl-3 text-right font-mono text-[12px] text-[#80868b]"
        style={{ lineHeight: `${LINE_HEIGHT}px` }}
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1" style={{ height: lines * LINE_HEIGHT + 16 }}>
        <pre
          ref={preRef}
          aria-hidden
          className={cn(
            shared,
            'pointer-events-none absolute inset-0 overflow-hidden text-foreground',
          )}
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        >
          {value ? highlighted : <span className="text-muted-foreground/60">{placeholder}</span>}
        </pre>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (preRef.current) {
              preRef.current.scrollTop = e.currentTarget.scrollTop;
              preRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          aria-label="Query"
          className={cn(
            shared,
            'absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/20 selection:text-transparent',
          )}
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        />
      </div>
    </div>
  );
}
