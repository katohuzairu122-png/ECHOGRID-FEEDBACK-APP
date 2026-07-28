import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/**
 * Native <select> primitive (i18n & Multi-Currency Block 3's settings form
 * is the first caller -- locale/currency pickers over small, closed option
 * sets). Deliberately not a custom-styled combobox: every option set this
 * component serves today (3 locales, ~20 common currencies) is short
 * enough that the platform-native picker (search-as-you-type on desktop,
 * a proper wheel/sheet on mobile) is better UX than a hand-rolled one,
 * and it comes with correct keyboard/screen-reader behavior for free.
 * Styling mirrors input.tsx exactly so the two are visually interchangeable
 * inside the same form grid.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:border-brand-600',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-danger aria-invalid:ring-1 aria-invalid:ring-danger',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
