import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Exported so a plain <Link> can be styled identically to a Button
// (buttonVariants({variant, size})) without nesting a real <button> inside
// an <a> -- interactive-in-interactive nesting breaks accessible-name
// computation and click semantics. See dashboard/page.tsx's "View branches"
// link, fixed to this pattern while writing Branch Mgmt Block 6's E2E test.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // bg-brand-700 (not -600): the new canonical emerald scale's -600
        // step is lighter at this position than the old custom scale's,
        // dropping white-on-brand-600 below WCAG AA (brand implementation,
        // Phase 2 contrast fix).
        primary: 'bg-brand-700 text-white hover:bg-brand-800',
        secondary: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-200',
        outline: 'border border-neutral-300 bg-transparent text-neutral-900 hover:bg-neutral-50',
        ghost: 'bg-transparent text-neutral-900 hover:bg-neutral-100',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/**
 * Base button primitive every screen should use instead of a raw <button>.
 * Plain native <button> under the hood, not a Base UI primitive -- a
 * native button already has full keyboard/AT support, nothing to layer on.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
