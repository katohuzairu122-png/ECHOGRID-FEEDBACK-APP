import { slugBaseFromName, slugCandidate } from '@echo-grid-feedback/shared-types';
import { AppError } from './errors';

/** Retries pass the same name within this window and get the record that already exists (no duplicate, no new slug). */
export const CREATION_REPLAY_WINDOW_SECONDS = 120;
export const MAX_SLUG_ATTEMPTS = 50;

/**
 * Deterministic uniqueness handling for a GENERATED slug: base, base-2, base-3, ... Each attempt is a conflict-safe
 * insert supplied by the caller, so two requests racing for the same name end up with different slugs and nothing
 * aborts. An established slug is never touched: this only ever chooses the slug of a row being created.
 */
export async function allocateSlug<T>(
  name: string,
  fallback: string,
  attempt: (slug: string) => Promise<T | undefined>,
): Promise<{ value: T; slug: string }> {
  const base = slugBaseFromName(name, fallback);
  for (let n = 1; n <= MAX_SLUG_ATTEMPTS; n += 1) {
    const slug = slugCandidate(base, n);
    if (!slug) continue;
    const value = await attempt(slug);
    if (value !== undefined) return { value, slug };
  }
  throw new AppError(
    'We could not find a free URL name for this name. Please try a slightly different name.',
    409,
    'SLUG_UNAVAILABLE',
  );
}

/** The first free candidate for a name (read-only), offered to the caller when an explicit slug is taken. */
export async function suggestSlug(
  name: string,
  fallback: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string | null> {
  const base = slugBaseFromName(name, fallback);
  for (let n = 1; n <= MAX_SLUG_ATTEMPTS; n += 1) {
    const slug = slugCandidate(base, n);
    if (slug && !(await isTaken(slug))) return slug;
  }
  return null;
}
