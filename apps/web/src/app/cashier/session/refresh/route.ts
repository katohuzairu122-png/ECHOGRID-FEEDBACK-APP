import { NextResponse, type NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { isCashierAppAvailable } from '@/lib/cashier/host';
import { refreshCashierSession } from '@/lib/cashier/auth-api';
import { isSameOriginRequest, isUserOwnNavigation, requestOrigin, safeNext } from '@/lib/cashier/refresh-guard';

/**
 * Cashier session refresh (SEC-CASHIER-R1 F3).
 *
 * Server components cannot write cookies and the production runtime skips middleware, so a route handler does the
 * token rotation. It is split in two so that a cashier arriving from ANOTHER site (the dashboard's "Open Cashier App",
 * an external link, a bookmark opened from a page) neither loops nor weakens the protection:
 *
 *  - GET changes nothing. It answers 200 with a small page that submits a same-origin POST to this same route. A GET
 *    never rotates a token (a prefetch or an image tag cannot force a rotation), and because it is a page, not a
 *    redirect, there is no redirect chain for a browser to count. The page submits ITSELF only for a navigation the
 *    user started on this site or typed (Sec-Fetch-Site same-origin or none). A navigation that arrives from another
 *    site (the dashboard's "Open Cashier App", an external link) or from a browser that sends no such header shows a
 *    Continue button instead, so the rotation needs a deliberate tap: another site cannot trigger it on its own.
 *  - A hop cookie (20 seconds) makes a second consecutive hand-off impossible: if the app sends the user straight back
 *    here after a successful rotation, the next stop is the sign-in, never another lap.
 *  - POST does the rotation, and only for a request that is provably same-origin (an Origin header equal to this
 *    origin, or Sec-Fetch-Site: same-origin when no Origin is sent). A cross-site POST is refused without touching the
 *    session, and the session cookies are SameSite=Lax, so the browser does not even attach them to one.
 *
 * Whatever happens, the flow ends: success redirects into the app (303), and any failure (revoked, expired, transient
 * upstream error, refused origin) lands on the sign-in with `?reason=session`, which never redirects back here. The
 * cookies are cleared only for a definitive refusal (see refreshCashierSession), never for a transient failure.
 */
const LOGIN_AFTER_FAILURE = '/cashier/login?reason=session';
const HOP_COOKIE = 'ff_cashier_hop';

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function available(): Promise<boolean> {
  return isCashierAppAvailable((await headers()).get('host'));
}

export async function GET(request: NextRequest) {
  if (!(await available())) return new NextResponse('Not found', { status: 404 });
  const base = requestOrigin(request);
  // A refresh just succeeded and the app still sent the user back here: stop at the sign-in rather than loop.
  if (request.cookies.has(HOP_COOKIE)) {
    const stop = NextResponse.redirect(new URL(LOGIN_AFTER_FAILURE, base), 303);
    stop.cookies.delete({ name: HOP_COOKIE, path: '/cashier' });
    return stop;
  }
  const next = escapeAttribute(safeNext(request.nextUrl.searchParams.get('next')));
  const automatic = isUserOwnNavigation(request);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Echo Grid Cashier</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">
<form id="refresh" method="post" action="/cashier/session/refresh">
<input type="hidden" name="next" value="${next}">
${automatic ? '<noscript>' : ''}<button type="submit" style="padding:14px 24px;font-size:18px;min-height:48px">Continue to the cashier app</button>${automatic ? '</noscript>' : ''}
</form>
${automatic ? "<script>document.getElementById('refresh').submit()</script>" : ''}
</body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  if (!(await available())) return new NextResponse('Not found', { status: 404 });
  const base = requestOrigin(request);
  const login = new URL(LOGIN_AFTER_FAILURE, base);
  if (!isSameOriginRequest(request)) return NextResponse.redirect(login, 303);
  const form = await request.formData().catch(() => null);
  const next = safeNext(typeof form?.get('next') === 'string' ? (form?.get('next') as string) : null);
  const ok = await refreshCashierSession();
  const response = NextResponse.redirect(ok ? new URL(next, base) : login, 303);
  if (ok) {
    response.cookies.set(HOP_COOKIE, '1', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/cashier', maxAge: 20 });
  }
  return response;
}
