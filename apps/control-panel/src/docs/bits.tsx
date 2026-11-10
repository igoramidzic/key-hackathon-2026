import type { SystemName } from '@sim/contracts';
import {
  Button,
  cn,
  highlight,
  StatusBadge,
  SystemLogo,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@sim/ui';
import { Check, Copy } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { type McpTool, type ToolKind, toolKind } from './mcp';

export function CopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className={className}
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="text-positive" /> : <Copy />}
    </Button>
  );
}

/** A code sample with syntax highlighting and a copy button. */
export function Snippet({
  code,
  language,
  className,
  title,
}: {
  code: string;
  language?: string;
  className?: string;
  title?: ReactNode;
}) {
  const html = useMemo(() => highlight(code, language), [code, language]);
  return (
    <div className={cn('group/snippet relative min-w-0 border bg-muted/40', className)}>
      {title && (
        <div className="border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {title}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-2.5 pr-10 font-mono text-[12.5px] leading-5">
        <code
          className="hljs"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
      <CopyButton text={code} className="absolute top-1.5 right-1.5 bg-background/80" />
    </div>
  );
}

/** Tabs of snippets (one per client or language). */
export function SnippetTabs({
  tabs,
}: {
  tabs: { id: string; label: string; code: string; language: string; note?: ReactNode }[];
}) {
  return (
    <Tabs defaultValue={tabs[0]?.id} className="min-w-0">
      <TabsList variant="line" className="flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="grid min-w-0 gap-2">
          {t.note && <p className="text-muted-foreground text-sm">{t.note}</p>}
          <Snippet code={t.code} language={t.language} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** Renders `backticked` spans as inline code; keeps line breaks. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <span className={cn('whitespace-pre-line', className)}>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
          <InlineCode key={i}>{p.slice(1, -1)}</InlineCode>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </span>
  );
}

export function InlineCode({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cn('bg-muted px-1 py-px font-mono text-[0.9em] text-foreground', className)}>
      {children}
    </code>
  );
}

const KIND: Record<
  ToolKind,
  { label: string; tone: 'neutral' | 'warning' | 'info'; title: string }
> = {
  read: { label: 'read', tone: 'neutral', title: 'Read-only: safe to call any time' },
  write: { label: 'write', tone: 'warning', title: 'Changes the simulated world' },
  idempotent: {
    label: 'write · idempotent',
    tone: 'info',
    title: 'Changes the world; repeating the same call has no extra effect',
  },
};

export function ToolKindBadge({ tool, compact }: { tool: McpTool; compact?: boolean }) {
  const k = KIND[toolKind(tool)];
  return (
    <span title={k.title}>
      <StatusBadge tone={k.tone} className={compact ? 'h-4 px-1 text-[10px]' : undefined}>
        {compact ? (k.label === 'read' ? 'R' : 'W') : k.label}
      </StatusBadge>
    </span>
  );
}

export const toolPath = (system: SystemName, tool: string) => `/docs/${system}/${tool}`;

/** A tool name as a link to its reference page. */
export function ToolLink({ system, name }: { system: SystemName; name: string }) {
  return (
    <Link
      to={toolPath(system, name)}
      className="inline-flex items-center gap-1 bg-muted px-1 py-px font-mono text-[0.85em] text-foreground underline-offset-2 hover:underline"
    >
      <ServiceLogo system={system} size="xs" />
      {name}
    </Link>
  );
}

export function Section({
  id,
  title,
  description,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('grid scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-3', className)}>
      <div className="grid gap-1">
        <h2 className="font-semibold text-lg tracking-tight">{title}</h2>
        {description && <p className="max-w-3xl text-muted-foreground text-sm">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const LOGO_SIZE = {
  xs: 'size-3 border-2',
  sm: 'size-3.5 border-[2.5px]',
  md: 'size-4 border-[3px]',
  lg: 'size-7 border-[5px]',
} as const;

/** A service's logo at docs sizes (the ServiceNow ring's stroke scales with it). */
export function ServiceLogo({
  system,
  size = 'md',
  className,
}: {
  system: SystemName;
  size?: keyof typeof LOGO_SIZE;
  className?: string;
}) {
  // The border classes only shape the ServiceNow ring; the SVG logos ignore them.
  return <SystemLogo system={system} className={cn(LOGO_SIZE[size], className)} />;
}
