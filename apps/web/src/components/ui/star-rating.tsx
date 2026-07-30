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

export function StarRating({
  name,
  defaultValue = 0,
  required,
  className,
}: StarRatingProps) {
  const [value, setValue] = React.useState(defaultValue);
  const [hovered, setHovered] = React.useState<number | null>(null);
  const displayValue = hovered ?? value;

  return (
    <div
      role="radiogroup"
      aria-label="Rating"
      className={cn('flex gap-1', className)}
    >
      {STAR_LABELS.map((label, index) => {
        const starValue = index + 1;
        const inputId = `${name}-${starValue}`;

        return (
          <label
            key={starValue}
            htmlFor={inputId}
            aria-label={label}
            className="-m-1 cursor-pointer touch-manipulation p-1"
            onClick={() => setValue(starValue)}
            onMouseEnter={() => setHovered(starValue)}
            onMouseLeave={() => setHovered(null)}
          >
            <input
              id={inputId}
              type="radio"
              name={name}
              value={starValue}
              checked={value === starValue}
              onChange={() => setValue(starValue)}
              required={required && starValue === 1}
              className="sr-only"
            />

            <StarIcon
              filled={starValue <= displayValue}
              className="pointer-events-none h-9 w-9"
            />
          </label>
        );
      })}
    </div>
  );
}