import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Generic status-pill primitive -- named/variant-ed by semantic color, not
 * by any one feature's vocabulary (e.g. NOT "new"/"reviewed"), so it's
 * reusable wherever else this app needs a small status indicator (loyalty
 * tiers, business status, etc. in later modules), matching Button's own
 * cva-variant convention.
 */
export const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        brand: 'bg-brand-100 text-brand-700',
        accent: 'bg-accent-400/20 text-accent-600',
        neutral: 'bg-neutral-100 text-neutral-600',
        // Added for Sentiment Analytics' AI-summary sentiment-count badges
        // (dashboard/analytics/summaries-list.tsx) -- same bg-{color}/10
        // tint approach as accent above, built from the single-shade
        // success/danger tokens in globals.css rather than adding new
        // color scales.
        success: 'bg-success/10 text-success',
        danger: 'bg-danger/10 text-danger',
        // Added for Billing's past_due/incomplete subscription statuses
        // (dashboard/billing/page.tsx) -- a cautionary state, distinct from
        // canceled/unpaid's danger severity. Same bg-{color}/10 tint
        // approach as success/danger, built from the existing --color-warning
        // token (globals.css) already used by dashboard/impersonation-banner.tsx.
        warning: 'bg-warning/10 text-warning',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
