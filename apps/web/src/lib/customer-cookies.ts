/**
 * Cookie name constant only -- mirrors lib/cookies.ts's pattern. Kept in its
 * own file (rather than adding to cookies.ts) so it's obvious at a glance
 * that this belongs to the customer identity domain, not staff -- no logic,
 * safe to import from middleware.ts's Edge runtime too if a future block
 * needs it there.
 */
export const CUSTOMER_TOKEN_COOKIE = 'ff_customer_token';
