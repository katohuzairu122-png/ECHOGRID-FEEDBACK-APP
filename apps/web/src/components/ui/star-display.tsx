import { StarIcon } from './star-icon';
import { cn } from '@/lib/utils';

export interface StarDisplayProps {
  value: number;
  className?: string;
}

/**
 * Read-only counterpart to StarRating (an input control) -- a feedback
 * inbox row displays an ALREADY-SUBMITTED rating, which isn't a form
 * interaction, so this deliberately has no radios/state/hooks at all, just
 * 5 StarIcons. Kept as its own component rather than a "readOnly" prop on
 * StarRating: that would force a genuinely static display to carry an
 * interactive widget's internal structure (labels, hidden inputs, hover
 * state) for no benefit. The two share only the icon (star-icon.tsx).
 */
export function StarDisplay({ value, className }: StarDisplayProps) {
  return (
    <div className={cn('flex gap-0.5', className)} role="img" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} filled={n <= value} className="h-4 w-4" />
      ))}
    </div>
  );
}
