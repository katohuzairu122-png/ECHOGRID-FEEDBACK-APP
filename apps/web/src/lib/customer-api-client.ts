import 'server-only';
import { redirect } from 'next/navigation';
import { API_BASE_URL, ApiError, parseEnvelope } from './api-client';
import { signedAttributionHeadersSafe } from './cashier/client-attribution';
import { getCustomerToken, hasRotatingRefreshCredential, wasCustomerRecentlyRefreshed } from './customer-session';

export const CUSTOMER_LOGIN_PATH = '/loyalty/login';
export const CUSTOMER_REFRESH_PATH = '/loyalty/session/refresh';
const DEFAULT_AFTER_LOGIN = '/loyalty/dashboard';

/**
 * The customer counterpart to apiFetch() -- attaches the customer JWT
 * (never the staff access token) and calls /loyalty/me/* routes. No 401-
 * refresh flow: a customer session is a single non-rotating 90-day token,
 * so there's nothing to refresh -- a 401 here means the token is missing,
 * expired, or invalid, full stop. Reuses parseEnvelope/ApiError from
 * api-client.ts to avoid a third copy of that envelope-parsing logic.
 *
 * ON A 401 THIS REDIRECTS TO /loyalty/login (audit P1-2)
 * This function's own doc used to say the CALLER "should redirect to
 * /loyalty/login". None of the eighteen call sites did. And the layout
 * above them gates on cookie PRESENCE only (customer-session.ts's
 * hasCustomerSession is a `store.has`, not a verify), so a cookie that is
 * still there while its JWT has expired passes the gate and then throws an
 * uncaught 401 one line into the page -- which, with no error boundary,
 * was a dead page with no route back to signing in.
 *
 * Handling it here rather than at each call site is the point: one place
 * covers all eighteen, and it makes the correct behaviour the default for
 * the nineteenth. It mirrors what lib/business.ts already does for the
 * staff side, which is the precedent this should have followed from the
 * start.
 *
 * `redirect()` throws a NEXT_REDIRECT control-flow error rather than
 * returning, so any caller that wraps this in try/catch must rethrow what
 * it does not recognise. Every current caller already does (the 404-
 * tolerant ones rethrow everything else), but it is the one way a future
 * caller could swallow this: a bare `catch {}` around customerApiFetch
 * would turn the redirect back into a broken page.
 */
export async function customerApiFetch<T>(
  path: string,
  init: RequestInit = {},
  loginNext?: string,
): Promise<T> {
  const loginPath = loginNext
    ? `${CUSTOMER_LOGIN_PATH}?next=${encodeURIComponent(loginNext)}`
    : CUSTOMER_LOGIN_PATH;
  // A rotating session whose access cookie has expired (or was refused) is renewed from its refresh credential, once; a
  // renewal that just happened and still fails goes to sign-in so the two can never loop. Cookies cannot be written while a
  // page renders, so the renewal runs in a route handler and returns here.
  const refreshPath = `${CUSTOMER_REFRESH_PATH}?next=${encodeURIComponent(loginNext ?? DEFAULT_AFTER_LOGIN)}`;
  const canRefresh = async () => (await hasRotatingRefreshCredential()) && !(await wasCustomerRecentlyRefreshed());
  const token = await getCustomerToken();
  if (!token) {
    // No token at all -- same destination, reached without a wasted API
    // round trip. Previously an immediate uncaught ApiError.
    redirect((await canRefresh()) ? refreshPath : loginPath);
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  for (const [name, value] of Object.entries(await signedAttributionHeadersSafe())) headers.set(name, value);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_BASE_URL}/api/v1${path}`, { ...init, headers });

  try {
    return await parseEnvelope<T>(response);
  } catch (err) {
    // A 401 normally means the session is gone. The one exception is OTP_INVALID: the API answers a wrong or expired phone
    // code with 401 too (it is a reply to the code the customer just typed, not a verdict on their session), so it must reach
    // the caller and keep the code step open instead of bouncing the customer to refresh or sign-in.
    if (err instanceof ApiError && err.status === 401 && err.code !== 'OTP_INVALID') {
      redirect((await canRefresh()) ? refreshPath : loginPath);
    }
    // Every other failure keeps surfacing as an ApiError for the nearest
    // error boundary. A 403, a 500 or a malformed envelope is not something
    // signing in again fixes, so redirecting on those would hide the real
    // fault behind a login screen the customer has already passed.
    throw err;
  }
}
