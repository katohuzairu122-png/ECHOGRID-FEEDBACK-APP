'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { StarIcon } from './star-icon';

export interface StarRatingProps {
  name: string;
  defaultValue?: number;
  required?: boolean;
  className?: string;
}

const STAR_LABELS = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'];

/**
 * Built on 5 real `<input type="radio">` elements sharing one `name`, not a
 * custom keyboard-driven widget -- a native radio group already gives
 * arrow-key navigation and "N of 5" screen-reader semantics for free, and
 * marking just the first radio `required` makes the browser enforce
 * "at least one selected" for the whole group with no extra JS validation.
 * The value flows through the surrounding <form action={formAction}> via
 * FormData exactly like every other field (see feedback-form.tsx), no
 * separate hidden-input/JSON wiring needed.
 *
 * Radios are visually hidden (sr-only, not display:none, so they stay in
 * the accessibility tree/tab order) and paired with a decorative SVG star
 * whose fill is driven by React state (selected value + hover preview).
 * Fully functional pre-hydration is not a goal -- consistent with every
 * other interactive control in this design system (Dialog, Button).
 */
export function StarRating({ name, defaultValue = 0, required, className }: StarRatingProps) {
  const [value, setValue] = React.useState(defaultValue);
  const [hovered, setHovered] = React.useState<number | null>(null);
  const displayValue = hovered ?? value;

  return (
    <div role="radiogroup" aria-label="Rating" className={cn('flex gap-1', className)}>
      {STAR_LABELS.map((label, i) => {
        const starValue = i + 1;
        return (
          <label
            key={starValue}
            className="-m-1 cursor-pointer p-1"
            onMouseEnter={() => setHovered(starValue)}
            onMouseLeave={() => setHovered(null)}
          >
            <input
              type="radio"
              name={name}
              value={starValue}
              checked={value === starValue}
              onChange={() => setValue(starValue)}
              required={required && starValue === 1}
              className="sr-only"
            />
            <span className="sr-only">{label}</span>
            <StarIcon filled={starValue <= displayValue} className="h-9 w-9" />
          </label>
        );
      })}
    </div>
  );
}
