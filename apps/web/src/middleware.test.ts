import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import { REFRESH_TOKEN_COOKIE } from '@/lib/cookies';

const ORIGIN = 'https://app.test';

function request(pathname: string, { signedIn = false } = {}) {
  const req = new NextRequest(new URL(pathname, ORIGIN));
  if (signedIn) req.cookies.set(REFRESH_TOKEN_COOKIE, 'a-refresh-token');
  return req;
}

/** `NextResponse.next()` has no redirect location; a redirect does. */
function redirectTarget(response: ReturnType<typeof middleware>): string | null {
  const location = response.headers.get('location');
  return location ? new URL(location).pathname : null;
}

describe('middleware — account recovery paths', () => {
  /**
   * The regression this file exists for. Recovery pages are reached by
   * definition without a session, so if they are not public the middleware
   * 307s the reset link to /login and the entire Block 1.5 API becomes
   * unreachable. The identical bug previously shipped for /feedback (see
   * middleware.ts's own comment), which is why it is worth a test rather
   * than a careful read.
   */
  it.each(['/forgot-password', '/reset-password'])(
    'serves %s to a signed-out visitor instead of redirecting to /login',
    (path) => {
      expect(redirectTarget(middleware(request(path)))).toBeNull();
    },
  );

  it('serves /reset-password with its token query string', () => {
    const req = new NextRequest(new URL('/reset-password?token=abc123', ORIGIN));
    expect(redirectTarget(middleware(req))).toBeNull();
  });

  /**
   * Someone resetting because they suspect a compromise is often still
   * signed in on the device reading the email. Bouncing them to /dashboard
   * -- which is what including these in STAFF_AUTH_PATHS would have done --
   * would leave them unable to finish.
   */
  it.each(['/forgot-password', '/reset-password'])(
    'does not bounce a signed-in user away from %s',
    (path) => {
      expect(redirectTarget(middleware(request(path, { signedIn: true })))).toBeNull();
    },
  );

  it('still bounces a signed-in user away from /login', () => {
    expect(redirectTarget(middleware(request('/login', { signedIn: true })))).toBe('/dashboard');
  });

  it('still gates a protected route for a signed-out visitor', () => {
    expect(redirectTarget(middleware(request('/dashboard')))).toBe('/login');
  });
});
