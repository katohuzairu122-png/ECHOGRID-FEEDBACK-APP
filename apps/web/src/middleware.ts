import { NextResponse, type NextRequest } from 'next/server';
import { REFRESH_TOKEN_COOKIE } from '@/lib/cookies';

// Staff sign-in pages: redirect AWAY to /dashboard if a staff refresh token
// is already present, same as before.
const STAFF_AUTH_PATHS = ['/login', '/signup'];
// Everything with its own, separate auth story -- never gated on the staff
// refresh-token cookie at all. /feedback (anonymous QR feedback) and
// /loyalty (anonymous QR check-in + SMS-OTP customer identity, a completely
// different principal from staff) both belong here. Fixed alongside the
// Loyalty module's customer-facing UI (Block 5) -- /feedback was previously
// NOT in this list, which meant this middleware's matcher (below) actually
// forced every anonymous customer hitting a QR code to /login, since it has
// no staff refresh token. That bug had gone unnoticed because the QR
// Engagement E2E suite runs against the API/pages directly, not through
// this middleware.
const PUBLIC_PATHS = ['/feedback', '/loyalty', ...STAFF_AUTH_PATHS];

/**
 * Presence-only gate, not a validity check -- redirects to /login if the
 * refresh-token cookie is simply missing. Deliberately does NOT verify the
 * token against the API on every request (that would mean a network round
 * trip for every navigation, including ones that touch no protected data);
 * actual validity is enforced by apiFetch() (lib/api-client.ts) wherever a
 * request is actually made to the API, which refreshes or surfaces a 401
 * there instead. Runs in the Edge runtime, so it uses NextRequest's own
 * cookie API rather than next/headers (see lib/session.ts, which can't be
 * imported here).
 */
export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isPublicPath = PUBLIC_PATHS.some((path) => pathname.startsWith(path));
  const isStaffAuthPath = STAFF_AUTH_PATHS.some((path) => pathname.startsWith(path));
  const hasRefreshToken = request.cookies.has(REFRESH_TOKEN_COOKIE);

  if (!isPublicPath && !hasRefreshToken) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (isStaffAuthPath && hasRefreshToken) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
