import type { FileDiff } from '@sim/contracts/gitlab';
import { Button, cn, highlight, languageForPath } from '@sim/ui';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { blobHref } from '../lib/api';
import { parseDiff } from '../lib/diff';
import { CopyButton, GlBadge } from './common';

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[12px] tabular-nums">
      <span className="text-positive">+{additions}</span>{' '}
      <span className="text-negative">−{deletions}</span>
    </span>
  );
}

const gutter =
  'w-[50px] min-w-[50px] px-2 text-right align-top text-gl-gray-500 select-none tabular-nums';

function FileDiffCard({
  diff,
  projectPath,
  viewRef,
}: {
  diff: FileDiff;
  projectPath: string;
  viewRef?: string;
}) {
  const [open, setOpen] = useState(true);
  const rows = useMemo(() => parseDiff(diff.diff), [diff.diff]);
  const lang = languageForPath(diff.new_path);
  const renamed = diff.renamed_file && diff.old_path !== diff.new_path;
  return (
    // No overflow clipping on the frame: it would break the sticky file header.
    <div id={`diff-${diff.new_path}`} className="scroll-mt-28 rounded-(--radius) border bg-card">
      <div
        className={cn(
          'sticky top-12 z-10 flex min-h-12 items-center gap-2 rounded-t-(--radius) bg-gl-subtle px-2 py-1.5',
          open ? 'border-b' : 'rounded-b-(--radius)',
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Hide file contents' : 'Show file contents'}
          className="hover:bg-black/[0.06]"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-semibold text-gl-strong text-xs">
          {renamed ? (
            <>
              <span className="font-normal text-muted-foreground">{diff.old_path} → </span>
              {diff.new_path}
            </>
          ) : (
            diff.new_path
          )}
        </span>
        <CopyButton text={diff.new_path} label="Copy file path" />
        {diff.new_file && <GlBadge variant="success">new file</GlBadge>}
        {diff.deleted_file && <GlBadge variant="danger">deleted</GlBadge>}
        <DiffStat additions={diff.additions} deletions={diff.deletions} />
        <span className="flex-1" />
        {viewRef && !diff.deleted_file && (
          <Button asChild variant="outline" size="sm" className="bg-background">
            <Link to={blobHref(projectPath, viewRef, diff.new_path)}>
              View file @ <span className="font-mono">{viewRef.slice(0, 8)}</span>
            </Link>
          </Button>
        )}
      </div>
      {open && (
        <div className="overflow-x-auto rounded-b-(--radius)">
          <table className="w-full border-collapse font-mono text-[12px] leading-5">
            <tbody>
              {rows.map((row, i) =>
                row.kind === 'hunk' ? (
                  <tr key={i} className="bg-gl-subtle text-muted-foreground">
                    <td className={gutter}>…</td>
                    <td className={gutter}>…</td>
                    <td className="whitespace-pre px-3 py-0.5">{row.text}</td>
                  </tr>
                ) : (
                  <tr
                    key={i}
                    className={cn(
                      row.kind === 'add' && 'bg-gl-diff-add',
                      row.kind === 'del' && 'bg-gl-diff-del',
                    )}
                  >
                    <td
                      className={cn(
                        gutter,
                        row.kind === 'add' && 'bg-gl-diff-add-gutter text-[#24663b]',
                        row.kind === 'del' && 'bg-gl-diff-del-gutter text-[#ae1800]',
                      )}
                    >
                      {row.oldNo ?? ''}
                    </td>
                    <td
                      className={cn(
                        gutter,
                        row.kind === 'add' && 'bg-gl-diff-add-gutter text-[#24663b]',
                        row.kind === 'del' && 'bg-gl-diff-del-gutter text-[#ae1800]',
                      )}
                    >
                      {row.newNo ?? ''}
                    </td>
                    <td className="whitespace-pre pr-4">
                      <span
                        className={cn(
                          'inline-block w-5 select-none text-center',
                          row.kind === 'add'
                            ? 'text-positive'
                            : row.kind === 'del'
                              ? 'text-negative'
                              : 'text-transparent',
                        )}
                      >
                        {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                      </span>
                      <span
                        className="hljs"
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes its input
                        dangerouslySetInnerHTML={{ __html: highlight(row.text, lang) || ' ' }}
                      />
                    </td>
                  </tr>
                ),
              )}
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-3 font-sans text-muted-foreground text-xs" colSpan={3}>
                    No content changes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** GitLab-style changes view: summary, file browser and one card per file. */
export function DiffView({
  diffs,
  projectPath,
  viewRef,
  className,
}: {
  diffs: FileDiff[];
  projectPath: string;
  /** Ref used for "View file" links (the commit sha or MR head). */
  viewRef?: string;
  className?: string;
}) {
  const additions = diffs.reduce((n, d) => n + d.additions, 0);
  const deletions = diffs.reduce((n, d) => n + d.deletions, 0);
  const tree = diffs.length > 1;
  return (
    <div className={cn('grid gap-3', className)}>
      <div className="text-muted-foreground text-xs">
        Showing{' '}
        <strong className="font-semibold text-gl-strong">
          {diffs.length} changed file{diffs.length === 1 ? '' : 's'}
        </strong>{' '}
        with{' '}
        <span className="font-semibold text-positive">
          {additions} addition{additions === 1 ? '' : 's'}
        </span>{' '}
        and{' '}
        <span className="font-semibold text-negative">
          {deletions} deletion{deletions === 1 ? '' : 's'}
        </span>
      </div>
      <div className={cn('grid items-start gap-4', tree && 'lg:grid-cols-[240px_minmax(0,1fr)]')}>
        {tree && (
          <nav
            aria-label="Changed files"
            className="grid gap-px text-xs lg:sticky lg:top-16 lg:max-h-[calc(100svh-5rem)] lg:overflow-y-auto"
          >
            {diffs.map((d) => (
              <a
                key={d.new_path}
                href={`#diff-${d.new_path}`}
                title={d.new_path}
                className="flex items-center gap-2 rounded-(--radius) px-2 py-1.5 transition-colors hover:bg-black/[0.06]"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{d.new_path.split('/').pop()}</span>
                <DiffStat additions={d.additions} deletions={d.deletions} />
              </a>
            ))}
          </nav>
        )}
        <div className="grid min-w-0 gap-4">
          {diffs.map((d) => (
            <FileDiffCard key={d.new_path} diff={d} projectPath={projectPath} viewRef={viewRef} />
          ))}
        </div>
      </div>
    </div>
  );
}
