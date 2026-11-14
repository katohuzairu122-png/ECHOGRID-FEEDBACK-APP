import { NextResponse, type NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { isCashierAppAvailable } from '@/lib/cashier/host';
import { refreshCashierSession } from '@/lib/cashier/auth-api';
import { isSameOriginRequest, safeNext } from '@/lib/cashier/refresh-guard';

/**
 * Cashier session refresh (SEC-CASHIER-R1 F3).
 *
 * Server components cannot write cookies and the production runtime skips middleware, so a route handler does the
 * token rotation. It is split in two so that a cashier arriving from ANOTHER site (the dashboard's "Open Cashier App",
 * an external link, a bookmark opened from a page) neither loops nor weakens the protection:
 *
 *  - GET changes nothing. It answers 200 with a small page that submits a same-origin POST to this same route. Because
 *    a GET never rotates a token, a cross-site navigation, a prefetch or an image tag cannot force a rotation, and
 *    because it is a page, not a redirect, no chain of redirects exists for a browser to count.
 *  - POST does the rotation, and only for a request that is provably same-origin (an Origin header equal to this
 *    origin, or Sec-Fetch-Site: same-origin when no Origin is sent). A cross-site POST is refused without touching the
 *    session, and the session cookies are SameSite=Lax, so the browser does not even attach them to one.
 *
 * Whatever happens, the flow ends: success redirects into the app (303), and any failure (revoked, expired, transient
 * upstream error, refused origin) lands on the sign-in with `?reason=session`, which never redirects back here. The
 * cookies are cleared only for a definitive refusal (see refreshCashierSession), never for a transient failure.
 */
const LOGIN_AFTER_FAILURE = '/cashier/login?reason=session';

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function available(): Promise<boolean> {
  return isCashierAppAvailable((await headers()).get('host'));
}

export async function GET(request: NextRequest) {
  if (!(await available())) return new NextResponse('Not found', { status: 404 });
  const next = escapeAttribute(safeNext(request.nextUrl.searchParams.get('next')));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Echo Grid Cashier</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<form id="refresh" method="post" action="/cashier/session/refresh">
<input type="hidden" name="next" value="${next}">
<noscript><button type="submit" style="padding:12px 20px;font-size:16px">Continue</button></noscript>
</form>
<script>document.getElementById('refresh').submit()</script>
</body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  if (!(await available())) return new NextResponse('Not found', { status: 404 });
  const login = new URL(LOGIN_AFTER_FAILURE, request.url);
  if (!isSameOriginRequest(request)) return NextResponse.redirect(login, 303);
  const form = await request.formData().catch(() => null);
  const next = safeNext(typeof form?.get('next') === 'string' ? (form?.get('next') as string) : null);
  const ok = await refreshCashierSession();
  return NextResponse.redirect(ok ? new URL(next, request.url) : login, 303);
}
