import type { SVGProps } from 'react';

/**
 * Shared wrapper for the landing page's 4 feature icons -- same stroke-
 * width/rounded-corner/currentColor convention star-icon.tsx already
 * establishes for this app's hand-rolled SVGs, so these read as part of
 * the same visual language rather than a mismatched icon set.
 */
function IconBase({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Feedback: a speech bubble with a star, echoing the app's own star-rating
 * input -- "collect feedback" made concrete rather than abstract. */
export function FeedbackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5v-9Z" />
      <path d="M12 7.2l1 2 2.2.2-1.7 1.5.5 2.1-2-1.2-2 1.2.5-2.1L8.8 9.4l2.2-.2 1-2Z" />
    </IconBase>
  );
}

/** Insights: a simple upward bar chart -- "understand" made concrete. */
export function InsightsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M20 20V13" />
      <path d="M4 20h16" />
    </IconBase>
  );
}

/** Action: a target with a center dot -- "turn insights into measurable
 * growth" made concrete. */
export function ActionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** Loyalty: a badge/ribbon shape -- "reward customers" made concrete,
 * distinct from the star (already used for ratings) to avoid the two
 * reading as the same concept. */
export function LoyaltyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="9" r="5.5" />
      <path d="M9 13.5 7.5 20l4.5-2.5 4.5 2.5-1.5-6.5" />
    </IconBase>
  );
}
