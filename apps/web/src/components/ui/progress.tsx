import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0-100. Callers compute the percentage (e.g. points toward next tier) --
   * this component only renders it, matching StarDisplay's "dumb display"
   * philosophy elsewhere in this design system. */
  value: number;
  label?: string;
}

/**
 * New general-purpose primitive, not a loyalty-specific one -- added for
 * the Loyalty module's tier-progress bar, but built as shared design-system
 * infrastructure (like Badge already is) since any future "progress toward
 * a goal" UI elsewhere in the app should reuse this instead of a one-off.
 */
export function Progress({ value, label, className, ...props }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div className={cn('flex flex-col gap-1', className)} {...props}>
      {label && <span className="text-xs font-medium text-neutral-600">{label}</span>}
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-neutral-100"
      >
        <div
          className="h-full rounded-full bg-brand-500 transition-[width]"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
