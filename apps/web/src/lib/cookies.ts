/**
 * Cookie name constants only -- no logic, no 'server-only' guard, safe to
 * import from anywhere including middleware.ts (which runs in the Edge
 * runtime and uses NextRequest/NextResponse's own cookie API, not
 * next/headers -- see lib/session.ts for the version middleware can't use).
 */
export const ACCESS_TOKEN_COOKIE = 'ff_access_token';
export const REFRESH_TOKEN_COOKIE = 'ff_refresh_token';

// Platform Admin Console Block 7 (impersonation). ADMIN_*_COOKIE stash the
// platform admin's real session while ACCESS_TOKEN_COOKIE/REFRESH_TOKEN_COOKIE
// above hold the impersonated user's instead -- see lib/session.ts's
// startImpersonation/stopImpersonation. IMPERSONATING_COOKIE is a cheap,
// presence-only flag (no token, just "1") so pages that need to know
// whether to render the exit banner can check without an API round trip.
export const ADMIN_ACCESS_TOKEN_COOKIE = 'ff_admin_access_token';
export const ADMIN_REFRESH_TOKEN_COOKIE = 'ff_admin_refresh_token';
export const IMPERSONATING_COOKIE = 'ff_impersonating';
