/**
 * Cookie name constant only -- mirrors lib/cookies.ts's pattern. Kept in its
 * own file (rather than adding to cookies.ts) so it's obvious at a glance
 * that this belongs to the customer identity domain, not staff -- no logic,
 * safe to import from middleware.ts's Edge runtime too if a future block
 * needs it there.
 */
export const CUSTOMER_TOKEN_COOKIE = 'ff_customer_token';


/** Short-lived server-side binding between OTP request and verification. */
export const CUSTOMER_PENDING_PHONE_COOKIE = 'ff_customer_pending_phone';

/** Loop breaker for the rotating-session refresh redirect: set for a minute after a successful refresh. */
export const CUSTOMER_RECENTLY_REFRESHED_COOKIE = 'ff_customer_refreshed';
