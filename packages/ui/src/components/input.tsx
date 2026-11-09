import { cn } from 'cn';
import type * as React from 'react';

// Finnear's inputs are amounts, rates and names, never credentials, so
// password managers stay out of them unless a field names what it holds
// with a real autoComplete token.
const passwordManagerIgnore = {
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
};

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  const ignore = props.autoComplete === undefined || props.autoComplete === 'off';
  return (
    <input
      type={type}
      data-slot="input"
      autoComplete="off"
      {...(ignore ? passwordManagerIgnore : null)}
      className={cn(
        'h-8 w-full min-w-0 rounded-(--radius) border border-input bg-transparent px-2.5 py-1 text-xs transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 md:text-xs dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
