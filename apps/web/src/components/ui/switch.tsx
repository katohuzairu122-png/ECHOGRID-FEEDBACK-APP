import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/**
 * Checkbox-based toggle, styled as a pill switch -- added in Notifications
 * Block 5 (first boolean-toggle need in the design system; every prior
 * module only needed text/number inputs or a status Button like
 * RewardRowActions). Plain <input type="checkbox"> under the hood, same
 * "native element already has full keyboard/AT support" reasoning as
 * Button/Input, rather than a custom role="switch" div reimplementing
 * space/enter handling and focus management from scratch.
 *
 * Works both as an uncontrolled field inside a useActionState form
 * (defaultChecked + name, e.g. notification settings' kill switches) and as
 * a controlled field driven by useState (e.g. the preferences grids, which
 * submit a structured array a raw FormData parse can't represent well).
 *
 * The input is visually hidden (sr-only) but still in the tab order and
 * still what a screen reader announces -- give every instance an
 * aria-label (or aria-labelledby) rather than wrapping in <Label htmlFor>,
 * since this component's root is already a <label> and nesting a second
 * <label> around it is invalid HTML.
 */
export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, ...props }, ref) => (
    <label
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center',
        className,
      )}
    >
      <input type="checkbox" ref={ref} className="peer sr-only" {...props} />
      <span
        className={cn(
          'absolute inset-0 rounded-full bg-neutral-300 transition-colors',
          'peer-checked:bg-brand-600',
          'peer-focus-visible:outline peer-focus-visible:outline-2',
          'peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600',
          'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        )}
      />
      <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
    </label>
  ),
);
Switch.displayName = 'Switch';
