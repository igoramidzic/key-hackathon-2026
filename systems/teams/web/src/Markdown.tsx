import { cn } from '@sim/ui';
import { createContext, type ReactNode, useContext } from 'react';
import { Link } from 'react-router';

export interface MarkdownEnv {
  /** username -> display name, for rendering mentions. */
  names: Map<string, string>;
  /** channel name -> id, for linking #channel references. */
  channels: Map<string, string>;
  viewer: string;
  link: (path: string) => string;
}

const EnvContext = createContext<MarkdownEnv>({
  names: new Map(),
  channels: new Map(),
  viewer: '',
  link: (p) => p,
});

export const MarkdownEnvProvider = EnvContext.Provider;

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s)<]+[^\s)<.,;:!?])|((?<![\w.@])@[a-z0-9][a-z0-9_.-]*[a-z0-9_])|((?<![\w#])#[a-z][a-z0-9]*-[a-z0-9-]+)|((?<![\w])_[^_\n]+_(?![\w]))/gi;

function Inline({ text, mentions }: { text: string; mentions: string[] }) {
  const env = useContext(EnvContext);
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const [token, code, bold, link, url, mention, channel, italic] = match;
    const key = `${i++}`;
    if (code) {
      out.push(
        <code
          key={key}
          className="rounded-[3px] bg-accent px-1 py-px font-mono text-[12.5px] text-foreground ring-1 ring-border ring-inset"
        >
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      out.push(
        <strong key={key} className="font-semibold">
          <Inline text={bold.slice(2, -2)} mentions={mentions} />
        </strong>,
      );
    } else if (link) {
      const m = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(<ExternalA key={key} href={m[2]!} label={m[1]!} />);
    } else if (url) {
      out.push(<ExternalA key={key} href={url} label={url} />);
    } else if (mention) {
      const username = mention.slice(1).toLowerCase();
      if (mentions.includes(username)) {
        const isViewer = username === env.viewer;
        out.push(
          <span
            key={key}
            title={`@${username}`}
            className={cn(
              'font-semibold text-primary',
              isViewer && 'rounded-[3px] bg-brand-tint-strong px-0.5 text-brand-pressed',
            )}
          >
            {env.names.get(username) ?? `@${username}`}
          </span>,
        );
      } else {
        out.push(token);
      }
    } else if (channel) {
      const name = channel.slice(1).toLowerCase();
      const id = env.channels.get(name);
      out.push(
        id ? (
          <Link key={key} to={env.link(`/channels/${id}`)} className="text-primary hover:underline">
            {channel}
          </Link>
        ) : (
          token
        ),
      );
    } else if (italic) {
      out.push(
        <em key={key}>
          <Inline text={italic.slice(1, -1)} mentions={mentions} />
        </em>,
      );
    } else {
      out.push(token);
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function ExternalA({ href, label }: { href: string; label: string }) {
  const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : '#';
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer"
      className="break-all text-primary hover:underline"
    >
      {label}
    </a>
  );
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string };

function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(lines[i++]!.replace(re, ''));
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.trim().startsWith('```') &&
      !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

/** Renders the Teams markdown subset safely (no HTML injection). */
export function Markdown({
  body,
  mentions = [],
  className,
}: {
  body: string;
  mentions?: string[];
  className?: string;
}) {
  const blocks = parseBlocks(body);
  return (
    <div
      className={cn(
        'space-y-1.5 break-words text-[14px] text-foreground leading-[1.45]',
        className,
      )}
    >
      {blocks.map((block, i) => {
        if (block.kind === 'code') {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-[4px] bg-accent px-3 py-2 font-mono text-[12.5px] text-foreground leading-5 ring-1 ring-border"
            >
              {block.text}
            </pre>
          );
        }
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List
              key={i}
              className={cn('space-y-0.5 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}
            >
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} mentions={mentions} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                <Inline text={line} mentions={mentions} />
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
