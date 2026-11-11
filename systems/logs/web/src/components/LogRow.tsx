import type { LogEntry } from '@sim/contracts/logs';
import { logMessage } from '@sim/contracts/logs';
import { Button, cn, JsonView } from '@sim/ui';
import { Check, ChevronRight, Copy, Waypoints } from 'lucide-react';
import { memo, useState } from 'react';
import { formatLogTime, SeverityIcon } from '../lib';

function statusClass(status: number) {
  if (status >= 500) return 'bg-[#fce8e6] text-[#c5221f]';
  if (status >= 400) return 'bg-[#fef7e0] text-[#b06000]';
  return 'bg-[#e6f4ea] text-[#137333]';
}

function Chip({
  children,
  title,
  onClick,
  className,
}: {
  children: string;
  title: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex h-5 shrink-0 cursor-pointer items-center rounded-[4px] px-1.5 text-[12px] ring-1 ring-inset transition-colors',
        className,
      )}
    >
      {children}
    </button>
  );
}

export const LogRow = memo(function LogRow({
  entry,
  expanded,
  fresh,
  onToggle,
  onAddClause,
}: {
  entry: LogEntry;
  expanded: boolean;
  fresh?: boolean;
  onToggle: (insertId: string) => void;
  onAddClause: (clause: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const message = logMessage(entry) || entry.jsonPayload?.error?.message || '';
  const tla = entry.labels?.app_tla;
  const service = entry.resource?.labels?.container_name;
  const http = entry.httpRequest;

  return (
    <div
      data-demo="log-row"
      data-severity={entry.severity}
      className={cn('border-b border-[#e8eaed] last:border-b-0', expanded && 'bg-[#f8f9fa]')}
    >
      <div
        onClick={() => onToggle(entry.insertId)}
        className={cn(
          'group flex h-8 cursor-pointer items-center gap-2 pr-4 pl-2 text-[13px] hover:bg-[#f1f3f4]',
          fresh && 'animate-[flash_1.6s_ease-out]',
        )}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <SeverityIcon severity={entry.severity} className="w-[68px] pl-1" />
        <span className="w-[190px] shrink-0 text-[13px] text-foreground tabular-nums">
          {formatLogTime(entry.timestamp)}
        </span>
        {tla && (
          <Chip
            title={`Add labels.app_tla="${tla}" to query`}
            onClick={() => onAddClause(`labels.app_tla="${tla}"`)}
            className="bg-accent font-medium text-accent-foreground ring-transparent hover:ring-primary/50"
          >
            {tla}
          </Chip>
        )}
        {service && (
          <Chip
            title={`Add resource.labels.container_name="${service}" to query`}
            onClick={() => onAddClause(`resource.labels.container_name="${service}"`)}
            className="bg-background text-[#3c4043] ring-border hover:bg-muted hover:ring-[#bdc1c6]"
          >
            {service}
          </Chip>
        )}
        {http && (
          <span
            className={cn(
              'inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] px-1.5 font-medium text-[12px] tabular-nums',
              statusClass(http.status),
            )}
          >
            {http.requestMethod} {http.status}
            {http.latency && <span className="opacity-70">{http.latency}</span>}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-foreground">
          {message || <span className="text-muted-foreground">(no message)</span>}
        </span>
      </div>
      {expanded && (
        <div className="space-y-2 pt-1 pr-4 pb-3 pl-[34px]">
          <div className="flex flex-wrap items-center gap-2">
            {entry.trace && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2.5 font-medium text-[13px] text-primary hover:bg-accent hover:text-primary"
                onClick={() => onAddClause(`trace="${entry.trace}"`)}
              >
                <Waypoints data-icon="inline-start" />
                Show entries for this trace
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2.5 font-medium text-[13px] text-primary hover:bg-accent hover:text-primary"
              onClick={() => {
                void navigator.clipboard?.writeText(JSON.stringify(entry, null, 2));
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              {copied ? 'Copied' : 'Copy JSON'}
            </Button>
            <span className="ml-auto font-mono text-[12px] text-muted-foreground">
              insertId {entry.insertId}
            </span>
          </div>
          <div className="max-h-[420px] overflow-auto rounded-[4px] border bg-card px-4 py-3">
            <JsonView value={entry} />
          </div>
        </div>
      )}
    </div>
  );
});
