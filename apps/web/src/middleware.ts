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
// Next.js file-convention metadata/asset routes (Echo Grid brand
// implementation, Phase 4) -- these are fetched anonymously by browsers
// (favicon/manifest, before any session exists) and by crawlers/social
// scrapers (robots.txt, sitemap.xml, OG/Twitter images), never carrying the
// staff refresh-token cookie. Without this, every one of them 307-redirected
// to /login instead of serving the actual asset -- caught by hitting them
// directly against the local dev server during Phase 9 verification.
const METADATA_ASSET_PATHS = [
  '/icon',
  '/apple-icon',
  '/opengraph-image',
  '/twitter-image',
  '/manifest.webmanifest',
  '/robots.txt',
  '/sitemap.xml',
  // PWA install assets (manifest icons, service worker, its offline
  // fallback) -- same class of anonymous-fetch-before-any-session request
  // as everything else in this list, so the same bug applies: a browser
  // installing the app, or the service worker registering itself, carries
  // no refresh-token cookie either.
  '/pwa-icon-192',
  '/pwa-icon-512',
  '/sw.js',
  '/offline.html',
];
const PUBLIC_PATHS = ['/feedback', '/loyalty', ...STAFF_AUTH_PATHS, ...METADATA_ASSET_PATHS];
// The root route is the public landing page as of the Echo Grid rebrand
// (previously an unconditional redirect to /dashboard, which is why this
// wasn't needed before). Checked by EXACT match below, never added to
// PUBLIC_PATHS itself -- every entry there is prefix-matched
// (`startsWith`), and '/' is a prefix of literally every pathname, which
// would make the whole app public. page.tsx already redirects an
// authenticated visitor from '/' to '/dashboard' on its own (the same
// "every protected route re-verifies its own session" pattern this app
// uses everywhere else, not just an artifact of NEXT_PRIVATE_MINIMAL_MODE
// currently skipping this file in production -- see wrangler.toml), so
// this only needs to stop middleware force-redirecting a signed-out
// visitor away from it.
const ROOT_PATH = '/';

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
  const isPublicPath = pathname === ROOT_PATH || PUBLIC_PATHS.some((path) => pathname.startsWith(path));
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
