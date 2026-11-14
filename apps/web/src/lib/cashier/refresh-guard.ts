import type { NextRequest } from 'next/server';

// Kept out of the route file: a Next.js route module may export only its HTTP handlers.

/** Only ever back into the cashier app, never to the sign-in or this handler (no loops, no open redirect). */
export function safeNext(requested: string | null | undefined): string {
  const value = requested ?? '';
  const ok =
    value.startsWith('/cashier') &&
    !value.startsWith('//') &&
    !value.startsWith('/cashier/session') &&
    !value.startsWith('/cashier/login') &&
    !/[\\\r\n]/.test(value);
  return ok ? value : '/cashier';
}

/**
 * The origin the browser addressed: its Host header and the forwarded protocol. `request.url` is the server's own view
 * (behind some runtimes it is the bind address, not the public host), so redirects and the same-origin comparison use
 * the Host the browser actually sent. A forged Host cannot make a cross-site POST look same-origin: its Origin header is
 * the attacker's site, which never equals the Host the browser sent to the cashier host.
 */
export function requestOrigin(request: NextRequest): string {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

/** True only for a request the browser itself marks as coming from this origin. */
export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === requestOrigin(request);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
