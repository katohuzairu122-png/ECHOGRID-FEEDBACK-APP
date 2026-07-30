import * as React from 'react';
import { cn } from '@/lib/utils';

export interface StarIconProps extends React.SVGAttributes<SVGSVGElement> {
  filled?: boolean;
}

/**
 * Shared decorative star glyph -- extracted out of star-rating.tsx (QR
 * Engagement Block 3) so star-display.tsx (Block 5, read-only) can reuse
 * the exact same icon markup instead of a second copy of the path data.
 * Purely visual: always aria-hidden, callers are responsible for the
 * accessible name/semantics around it (see StarRating and StarDisplay).
 */
export function StarIcon({ filled = false, className, ...props }: StarIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      className={cn(
        'transition-colors',
        // Star fill uses the dedicated --color-star-fill token (globals.css),
        // deliberately decoupled from --color-accent-* -- owner decision to
        // keep the conventional amber/gold star rating regardless of the
        // brand's teal-cyan accent color.
        filled ? 'fill-star-fill text-star-fill' : 'fill-transparent text-neutral-300',
        className,
      )}
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.563.563 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
      />
    </svg>
  );
}
