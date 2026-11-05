/**
 * S08-D1D3-DEV-07: pagination completeness for provider lists. A list is COMPLETE only when the recorded page sequence provably covers it: the first page was requested without a
 * cursor, every later page was requested with the id of the last item of the page before it, the final page says has_more=false, and nothing follows it. Anything else is
 * INCOMPLETE (nothing may be concluded, in particular not "absent"), MALFORMED (the pages are not shaped like provider lists) or CONTRADICTORY (the pages disagree with themselves).
 */
export interface PageRecord {
  /** The `starting_after` cursor this page was requested with; null for the first page. Recorded by the acquirer, never taken from the response. */
  readonly requestedStartingAfter: string | null;
  readonly body: unknown;
}
export type PageOutcome =
  | Readonly<{ state: 'COMPLETE'; items: readonly unknown[] }>
  | Readonly<{ state: 'INCOMPLETE' | 'MALFORMED' | 'CONTRADICTORY'; reason: string }>;

export const MAX_PAGES = 20;
export const MAX_ITEMS = 1000;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

export function collectPages(pages: readonly PageRecord[] | null | undefined, idOf: (item: unknown) => string | null): PageOutcome {
  if (!Array.isArray(pages) || pages.length === 0) return { state: 'INCOMPLETE', reason: 'NO_PAGES' };
  if (pages.length > MAX_PAGES) return { state: 'INCOMPLETE', reason: 'TOO_MANY_PAGES' };
  const items: unknown[] = []; const seen = new Set<string>();
  let previousLast: string | null = null; let previousHasMore = false;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!isObj(page) || !isObj(page.body)) return { state: 'MALFORMED', reason: 'PAGE_SHAPE' };
    const b = page.body;
    if (b.object !== 'list' || !Array.isArray(b.data) || typeof b.has_more !== 'boolean') return { state: 'MALFORMED', reason: 'PAGE_SHAPE' };
    if (i === 0 ? page.requestedStartingAfter !== null : (!previousHasMore || page.requestedStartingAfter !== previousLast)) return { state: 'CONTRADICTORY', reason: 'PAGE_SEQUENCE_BROKEN' };
    if (b.data.length === 0 && b.has_more) return { state: 'MALFORMED', reason: 'EMPTY_PAGE_WITH_MORE' };
    for (const item of b.data) {
      const id = idOf(item);
      if (id === null) return { state: 'MALFORMED', reason: 'ITEM_ID' };
      if (seen.has(id)) return { state: 'CONTRADICTORY', reason: 'DUPLICATE_ITEM_ID' };
      seen.add(id); items.push(item);
      if (items.length > MAX_ITEMS) return { state: 'INCOMPLETE', reason: 'TOO_MANY_ITEMS' };
    }
    previousLast = b.data.length ? idOf(b.data[b.data.length - 1]) : previousLast;
    previousHasMore = b.has_more;
    if (!b.has_more && i !== pages.length - 1) return { state: 'CONTRADICTORY', reason: 'PAGES_AFTER_FINAL' };
  }
  if (previousHasMore) return { state: 'INCOMPLETE', reason: 'PAGINATION_INCOMPLETE' };
  return { state: 'COMPLETE', items };
}
