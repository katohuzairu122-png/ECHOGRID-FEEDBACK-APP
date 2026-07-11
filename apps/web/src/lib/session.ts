import 'server-only';
import { cookies } from 'next/headers';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ADMIN_ACCESS_TOKEN_COOKIE,
  ADMIN_REFRESH_TOKEN_COOKIE,
  IMPERSONATING_COOKIE,
} from './cookies';

const ACCESS_TOKEN_MAX_AGE = 15 * 60; // matches apps/api's JWT_ACCESS_SECRET TTL
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60; // matches apps/api's JWT_REFRESH_SECRET TTL
// Not a usable refresh token -- see startImpersonation's comment. Any real
// verification attempt against this string fails cleanly.
const IMPERSONATION_REFRESH_SENTINEL = 'impersonation-session-has-no-refresh-token';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Writes both tokens as httpOnly cookies -- the whole point of the BFF
 * pattern (Branch Mgmt Block 3): neither token is ever readable by
 * browser-side JS, closing off the most common XSS token-theft vector.
 * `secure` is conditional on NODE_ENV so plain http://localhost dev still
 * works (browsers silently drop `secure` cookies set over non-HTTPS).
 */
export async function setSession(tokens: AuthTokens): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';

  store.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE,
  });
  store.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });
}

export async function getAccessToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(ACCESS_TOKEN_COOKIE)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(REFRESH_TOKEN_COOKIE)?.value;
}

/**
 * Presence-only check for Server Components (e.g. the root page and the
 * dashboard layout) -- fast, no network call. Actual token validity is
 * enforced wherever apiFetch() is used; this only distinguishes
 * "definitely logged out" from "possibly logged in."
 */
export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  return store.has(REFRESH_TOKEN_COOKIE);
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  // Platform Admin Console Block 7: never leave a stale impersonation stash
  // behind when a session ends, however it ends -- explicit logout, or
  // apiFetch giving up after a failed refresh mid-impersonation. An orphaned
  // admin token sitting in cookies the UI can no longer reach to restore
  // would be a dangling credential, not just inconvenient. No-ops harmlessly
  // when there was no impersonation session to begin with.
  store.delete(ADMIN_ACCESS_TOKEN_COOKIE);
  store.delete(ADMIN_REFRESH_TOKEN_COOKIE);
  store.delete(IMPERSONATING_COOKIE);
}

/**
 * Switches the active session to an impersonated user: stashes the
 * platform admin's real access+refresh tokens (so stopImpersonation can
 * restore them), then overwrites the main cookies with the impersonation
 * access token. maxAge on all three new/changed cookies matches the token's
 * own expiry (auth/jwt.ts's IMPERSONATION_TOKEN_TTL_SECONDS, ~30 min), so
 * they all expire together rather than the flag outliving the token it
 * describes.
 *
 * REFRESH_TOKEN_COOKIE is set to a sentinel, not deleted -- deleting it
 * would make middleware.ts's presence-only hasRefreshToken check fail
 * immediately after this function returns, bouncing the admin straight back
 * to /login instead of into the impersonated session. The sentinel isn't a
 * real refresh token (impersonation tokens have none); if it's ever
 * actually submitted to /auth/refresh, verification fails and apiFetch
 * treats that exactly like any other unrecoverable 401 -- clearSession()
 * (which also wipes the stash, see above) and the user is logged out
 * cleanly, never silently falling back to reusing the admin's real
 * refresh token under an impersonated UI.
 */
export async function startImpersonation(tokens: { accessToken: string; expiresAt: Date }): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  const maxAge = Math.max(1, Math.floor((tokens.expiresAt.getTime() - Date.now()) / 1000));

  const adminAccess = store.get(ACCESS_TOKEN_COOKIE)?.value;
  const adminRefresh = store.get(REFRESH_TOKEN_COOKIE)?.value;
  if (adminAccess) {
    store.set(ADMIN_ACCESS_TOKEN_COOKIE, adminAccess, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: ACCESS_TOKEN_MAX_AGE,
    });
  }
  if (adminRefresh) {
    store.set(ADMIN_REFRESH_TOKEN_COOKIE, adminRefresh, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });
  }

  store.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  store.set(REFRESH_TOKEN_COOKIE, IMPERSONATION_REFRESH_SENTINEL, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  store.set(IMPERSONATING_COOKIE, '1', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

/**
 * Restores the platform admin's real session from the stash, or -- if the
 * stash is somehow missing (expired, or stopImpersonation is called without
 * a preceding startImpersonation) -- falls back to a clean logout rather
 * than leaving the admin in an ambiguous half-impersonating state.
 */
export async function stopImpersonation(): Promise<void> {
  const store = await cookies();
  const adminAccess = store.get(ADMIN_ACCESS_TOKEN_COOKIE)?.value;
  const adminRefresh = store.get(ADMIN_REFRESH_TOKEN_COOKIE)?.value;

  if (adminAccess && adminRefresh) {
    await setSession({ accessToken: adminAccess, refreshToken: adminRefresh });
    store.delete(ADMIN_ACCESS_TOKEN_COOKIE);
    store.delete(ADMIN_REFRESH_TOKEN_COOKIE);
    store.delete(IMPERSONATING_COOKIE);
  } else {
    await clearSession();
  }
}

/** Cheap, presence-only check (mirrors hasSession()) -- lets
 * dashboard/layout.tsx decide whether to pay for the one extra /auth/me
 * call the exit banner needs (dashboard/impersonation-banner.tsx) without
 * paying it on every page load for the overwhelming majority of sessions
 * that are never impersonating. */
export async function isImpersonating(): Promise<boolean> {
  const store = await cookies();
  return store.has(IMPERSONATING_COOKIE);
}
