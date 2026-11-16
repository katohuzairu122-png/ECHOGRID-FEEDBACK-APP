import { NextResponse, type NextRequest } from 'next/server';
import { refreshRotatingCustomerSession } from '@/lib/customer-session-refresh';
import { markCustomerRefreshed } from '@/lib/customer-session';
import { safeInternalPath } from '@/lib/safe-redirect';
import { CUSTOMER_LOGIN_PATH } from '@/lib/customer-api-client';

/**
 * Renews a rotating customer session, then returns the customer to where they were. This is where cookies may be written
 * (a Server Component render cannot), reached by redirect from `customerApiFetch` when an access token has expired.
 *
 * GET navigations cannot carry an Origin check, so a request that the browser marks as cross-site is refused outright
 * (`Sec-Fetch-Site`). Renewing only ever refreshes the caller's own session and returns nothing to the page, so a forged
 * navigation gains nothing. `next` is validated as a same-origin path.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const next = safeInternalPath(request.nextUrl.searchParams.get('next'), '/loyalty/dashboard');
  const to = (path: string) => NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);
  const login = `${CUSTOMER_LOGIN_PATH}?next=${encodeURIComponent(next)}`;

  if (request.headers.get('sec-fetch-site') === 'cross-site') return to(login);
  const outcome = await refreshRotatingCustomerSession();
  if (outcome !== 'refreshed' && outcome !== 'conflict') return to(login);
  // A conflict means a concurrent request already rotated the pair and set the shared cookies, so return to the page. The
  // marker bounds this to one extra attempt: if that page still gets a 401 the customer goes to sign-in, never a loop.
  await markCustomerRefreshed();
  return to(next);
}
