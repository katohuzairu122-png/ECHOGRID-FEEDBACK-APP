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

/** True only for a request the browser itself marks as coming from this origin. */
export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
