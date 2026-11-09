import { cn } from '@sim/ui';
import type { ReactNode } from 'react';

/** Moogsoft content panel: white box, gray title strip. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-(--radius) border bg-card shadow-[0_1px_2px_rgba(16,36,60,0.06)]',
        className,
      )}
    >
      <header className="flex h-9 items-center gap-2 border-b bg-[#f5f7fa] px-3">
        <h2 className="font-semibold text-[13px] text-foreground">{title}</h2>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Label/value rows, Moogsoft's details-table look. */
export function DetailRows({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-border/70">
      {items.map((item) => (
        <div key={item.label} className="grid grid-cols-[124px_1fr] gap-3 px-3 py-[7px]">
          <dt className="font-semibold text-[12px] text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words text-[13px] text-foreground">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
