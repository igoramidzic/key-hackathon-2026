import { Button, cn } from '@sim/ui';
import { ChevronLeft, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Form header bar: back arrow, record type over the record's display value, and the form's
 * UI actions on the right. Sticks under the unified navigation header.
 */
export function FormHeader({
  backTo,
  backLabel,
  recordType,
  title,
  actions,
}: {
  backTo: string;
  backLabel: string;
  recordType: string;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="sticky top-12 z-10 -mx-4 -mt-4 mb-4 border-b bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
      <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2">
        <Button
          asChild
          variant="outline"
          size="icon-sm"
          aria-label={backLabel}
          className="text-foreground"
        >
          <Link to={backTo}>
            <ChevronLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="font-bold text-[15px] text-foreground">{recordType}</div>
          <div className="truncate text-[13px] text-muted-foreground">{title}</div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** White form body that holds the field grid. */
export function FormBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-(--radius) border bg-card px-4 py-5', className)}>{children}</div>
  );
}

/** Two field columns, side by side on wide screens. */
export function FormColumns({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-10 gap-y-2.5 lg:grid-cols-2">{children}</div>;
}

export function FormColumn({ children }: { children: ReactNode }) {
  return <div className="min-w-0 space-y-2.5">{children}</div>;
}

/** Shared label column so half-width and full-width fields line up. */
const LABEL_COLS = 'grid-cols-[7rem_minmax(0,1fr)] sm:grid-cols-[10rem_minmax(0,1fr)]';

/**
 * A ServiceNow form field: right-aligned gray label, mandatory marker, and a boxed value.
 * Read-only values sit on a gray box; pass `editable` when the child is an input. `href` adds the
 * reference "i" button that opens the referenced record.
 */
export function FormField({
  label,
  htmlFor,
  children,
  multiline,
  mandatory,
  editable,
  href,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  multiline?: boolean;
  /** Shows the mandatory marker: red while empty, gray once filled. */
  mandatory?: 'empty' | 'filled';
  editable?: boolean;
  href?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-3',
        LABEL_COLS,
        multiline || editable ? 'items-start' : 'items-center',
      )}
    >
      <label
        htmlFor={htmlFor}
        className={cn(
          'flex items-center justify-end gap-1 text-right text-[13px] text-muted-foreground',
          (multiline || editable) && 'min-h-8 pt-0',
        )}
      >
        {mandatory && (
          <span
            aria-hidden="true"
            className={cn(
              'font-bold',
              mandatory === 'empty' ? 'text-destructive' : 'text-muted-foreground/60',
            )}
          >
            *
          </span>
        )}
        {label}
        {mandatory && <span className="sr-only">(mandatory)</span>}
      </label>
      <div className="flex min-w-0 items-stretch gap-1.5">
        {editable ? (
          <div className={cn('min-w-0 flex-1', className)}>{children}</div>
        ) : (
          <div
            className={cn(
              'flex min-h-8 min-w-0 flex-1 items-center rounded-(--radius) border border-border bg-readonly px-2.5 py-1 text-[13px] text-foreground',
              multiline && 'block whitespace-pre-wrap py-1.5',
              className,
            )}
          >
            {children}
          </div>
        )}
        {href && (
          <Button
            asChild
            variant="outline"
            size="icon-sm"
            className="size-8 text-muted-foreground"
            aria-label={`Open ${label} record`}
            title={`Open ${label} record`}
          >
            <Link to={href}>
              <Info />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Inputs inside form fields: white boxes with the field border. */
export const fieldInputClass = 'h-8 bg-card text-[13px] md:text-[13px]';
