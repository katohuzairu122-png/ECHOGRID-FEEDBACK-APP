import type { NextRequest } from 'next/server';

// Kept out of the route file: a Next.js route module may export only its HTTP handlers.

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

/**
 * Only ever back into the cashier app, never to the sign-in or the refresh handler (no loops, no open redirect).
 * The value is RESOLVED first and the resolved path is what is checked and returned, so dot segments, tabs and
 * encoded dots cannot make a string that starts with "/cashier" resolve somewhere else.
 */
export function safeNext(requested: string | null | undefined): string {
  const value = requested ?? '';
  // Reject anything that is not a plain path: control characters (tab, CR, LF), backslashes and any percent-encoding.
  if (value === '' || [...value].some((ch) => ch.charCodeAt(0) <= 0x1f || ch === '\u007f' || ch === '\\' || ch === '%')) return '/cashier';
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return '/cashier';
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return '/cashier';
  const path = url.pathname;
  // Repeated slashes are never a legitimate cashier path and are not collapsed consistently by every runtime.
  if (path.includes('//')) return '/cashier';
  const inApp = path === '/cashier' || path.startsWith('/cashier/');
  const forbidden = path.startsWith('/cashier/session') || path.startsWith('/cashier/login');
  return inApp && !forbidden ? path + url.search : '/cashier';
}

/**
 * The origin the browser addressed. `request.url` is the server's own view (behind some runtimes it is the bind
 * address, not the public host), so the Host the browser sent is used, with a whitelisted protocol. When the configured
 * CASHIER_APP_URL names that same host, its origin is used as-is (configuration, not a request header, decides).
 */
export function requestOrigin(request: NextRequest): string {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const configured = process.env.CASHIER_APP_URL?.trim();
  if (configured) {
    try {
      const c = new URL(configured);
      if (c.host.toLowerCase() === host.toLowerCase()) return c.origin;
    } catch {
      // A malformed setting is ignored; the request's own host is used below.
    }
  }
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

/** True only for a request the browser itself marks as coming from this origin. */
export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === requestOrigin(request);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** Navigations the user themselves started on this site (or typed): safe to continue without an explicit tap. */
export function isUserOwnNavigation(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}
