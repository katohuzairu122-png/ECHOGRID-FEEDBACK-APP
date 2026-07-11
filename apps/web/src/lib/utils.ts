import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges conditional class names (clsx) and resolves conflicting Tailwind
 * utility classes in favor of the last one (tailwind-merge) -- e.g.
 * cn('px-2', condition && 'px-4') correctly yields just 'px-4', not both
 * fighting for specificity. Every component in components/ui/ takes a
 * className prop and runs it through this instead of string concatenation.
 *
 * Named lib/utils.ts (not lib/cn.ts) to match the ecosystem-standard path
 * shadcn/ui and most Tailwind component recipes assume -- keeps the door
 * open to adopting shadcn-generated components later without an import
 * rewrite.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
