import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/**
 * The aria-invalid: variant (Tailwind v4's built-in ARIA-state support)
 * means a form only needs to set aria-invalid="true" on an invalid field --
 * no extra conditional className logic needed to show the error style, and
 * it's the same signal assistive tech uses, so visual and a11y state can
 * never drift apart.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900',
        'placeholder:text-neutral-400',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:border-brand-600',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-danger aria-invalid:ring-1 aria-invalid:ring-danger',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
