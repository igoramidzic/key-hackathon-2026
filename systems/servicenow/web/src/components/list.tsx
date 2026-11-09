import {
  Button,
  cn,
  Input,
  LoadMore,
  TableHead,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@sim/ui';
import { ArrowDown, ArrowUp, ChevronRight, Filter, Plus, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';

export type Crumb = { label: string; onClick?: () => void };

/**
 * A ServiceNow list: title bar (table name, New, search), filter breadcrumb, optional toolbar,
 * the table, and a row-count footer.
 */
export function ListFrame({
  title,
  newTo,
  search,
  crumbs,
  toolbar,
  count,
  children,
  hasMore,
  onMore,
  className,
}: {
  title: string;
  newTo?: string;
  search?: ReactNode;
  crumbs?: Crumb[];
  toolbar?: ReactNode;
  /** Rows shown and total, for the "1 to N of M" counters. */
  count?: { shown: number; total: number };
  children: ReactNode;
  hasMore?: boolean;
  onMore?: () => void;
  className?: string;
}) {
  const range =
    count &&
    (count.shown === 0 ? '0 records' : `1 to ${count.shown} of ${count.total.toLocaleString()}`);
  return (
    <section className={cn('overflow-hidden rounded-(--radius) border bg-card', className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <h1 className="font-bold text-[17px] text-foreground">{title}</h1>
        {newTo && (
          <Button asChild size="sm">
            <Link to={newTo}>
              <Plus data-icon="inline-start" />
              New
            </Link>
          </Button>
        )}
        {search}
        {range && (
          <span
            className="ml-auto text-[13px] text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {range}
          </span>
        )}
      </header>
      {crumbs && crumbs.length > 0 && <ListBreadcrumb crumbs={crumbs} />}
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
          {toolbar}
        </div>
      )}
      <div>{children}</div>
      {range && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t bg-list-header px-3 py-1.5 text-[13px] text-muted-foreground tabular-nums">
          <span>{range}</span>
          {onMore && <LoadMore hasMore={!!hasMore} onClick={onMore} />}
        </footer>
      )}
    </section>
  );
}

/** Filter breadcrumb: "All > Active = true > …". Each crumb drops the conditions after it. */
export function ListBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      aria-label="Filter"
      className="flex flex-wrap items-center gap-1 border-b bg-card px-3 py-1.5 text-[13px]"
    >
      <Filter className="mr-1 size-3.5 text-muted-foreground" aria-hidden="true" />
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="inline-flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />}
            {c.onClick && !last ? (
              <button
                type="button"
                onClick={c.onClick}
                className="text-link underline-offset-2 hover:underline"
              >
                {c.label}
              </button>
            ) : (
              <span className={cn(last ? 'text-foreground' : 'text-muted-foreground')}>
                {c.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** The title bar's "Search" box. */
export function ListSearch({
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-7 bg-card pl-8 text-[13px] md:text-[13px]"
      />
    </div>
  );
}

/** Classes for list tables: gray header row, dense striped rows, light blue hover. */
export const listHeaderRowClass = 'bg-list-header hover:bg-list-header';
export const listRowClass =
  'border-b border-border/70 even:bg-list-stripe hover:bg-list-hover [&>td]:py-1.5 [&>td]:text-[13px] [&>td:first-child]:pl-3';

export type SortDir = 'asc' | 'desc';

/** Column header with ServiceNow's sort affordance (arrow on the sorted column, hint on hover). */
export function SortHead({
  children,
  active,
  dir,
  onSort,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  dir?: SortDir;
  onSort?: () => void;
  className?: string;
}) {
  const base = 'h-9 border-r border-border/60 px-2 text-[13px] font-semibold last:border-r-0';
  if (!onSort)
    return <TableHead className={cn(base, 'first:pl-3', className)}>{children}</TableHead>;
  const Icon = active && dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn(base, 'p-0 first:pl-1', className)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={onSort}
        className="group/sort flex h-9 w-full items-center gap-1 px-2 text-left font-semibold hover:bg-border/40"
      >
        {children}
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            active
              ? 'text-foreground'
              : 'text-muted-foreground opacity-0 group-hover/sort:opacity-100',
          )}
          aria-hidden="true"
        />
      </button>
    </TableHead>
  );
}

/** Client-side column sort for lists the API returns unsorted. */
export function useClientSort<T, K extends string>(
  items: T[] | undefined,
  accessors: Record<K, (item: T) => string | number>,
  initial: NoInfer<K>,
) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<SortDir>('asc');
  // biome-ignore lint/correctness/useExhaustiveDependencies: accessors are static per call site
  const sorted = useMemo(() => {
    if (!items) return items;
    const get = accessors[key];
    return [...items].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c =
        typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return dir === 'asc' ? c : -c;
    });
  }, [items, key, dir]);
  const head = (k: K) => ({
    active: key === k,
    dir,
    onSort: () => {
      if (key === k) setDir(dir === 'asc' ? 'desc' : 'asc');
      else {
        setKey(k);
        setDir('asc');
      }
    },
  });
  return { sorted, head };
}

/** Related lists under a form: a tab per list, as ServiceNow shows them below the record. */
export function RelatedLists({
  lists,
}: {
  lists: { id: string; label: string; count?: number; content: ReactNode }[];
}) {
  const shown = lists.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <Tabs
      defaultValue={shown[0]!.id}
      className="gap-0 overflow-hidden rounded-(--radius) border bg-card"
    >
      <TabsList className="h-auto w-full justify-start rounded-none border-b bg-list-header p-0 group-data-horizontal/tabs:h-auto">
        {shown.map((l) => (
          <TabsTrigger
            key={l.id}
            value={l.id}
            className="h-10 flex-none rounded-none border-0 border-r border-r-border px-4 text-[13px] text-muted-foreground data-active:bg-card data-active:font-semibold data-active:text-foreground data-active:shadow-[inset_0_-2px_0_var(--primary)]"
          >
            {l.label}
            {l.count !== undefined && <span className="tabular-nums">({l.count})</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {shown.map((l) => (
        <TabsContent key={l.id} value={l.id} className="text-[13px]">
          {l.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
