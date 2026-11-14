import { NextResponse, type NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { isCashierAppAvailable } from '@/lib/cashier/host';
import { refreshCashierSession } from '@/lib/cashier/auth-api';

/**
 * Silent cashier session refresh. Server components cannot write cookies and the production runtime skips middleware,
 * so a route handler (which can write cookies) does the rotation: GET here, new cookies set, redirect back. Reached
 * only from the cashier layout when the 15-minute access token has lapsed or was refused. A session that can no longer
 * refresh (revoked, expired, access removed) lands on the cashier sign-in with its cookies cleared.
 */
export async function GET(request: NextRequest) {
  if (!isCashierAppAvailable((await headers()).get('host'))) {
    return new NextResponse('Not found', { status: 404 });
  }
  // Rotating a token is a state change behind a GET, so refuse it when another site triggered the navigation. The
  // cashier layout's own redirect is same-origin, so normal use is unaffected.
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.redirect(new URL('/cashier', request.url));
  }
  const requested = request.nextUrl.searchParams.get('next') ?? '';
  // Only ever back into the cashier app, and never to the sign-in or this handler (no loops, no open redirect).
  const safe =
    requested.startsWith('/cashier') && !requested.startsWith('//') && !requested.startsWith('/cashier/session') && !requested.startsWith('/cashier/login')
      ? requested
      : '/cashier';
  const ok = await refreshCashierSession();
  return NextResponse.redirect(new URL(ok ? safe : '/cashier/login?reason=session', request.url));
}
