import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@/lib/cookies';

const ORIGIN = 'https://app.test';

function request(pathname: string, { signedIn = false } = {}) {
  const req = new NextRequest(new URL(pathname, ORIGIN));
  if (signedIn) {
    req.cookies.set(ACCESS_TOKEN_COOKIE, 'an-access-token');
    req.cookies.set(REFRESH_TOKEN_COOKIE, 'a-refresh-token');
  }
  return req;
}

function redirectTarget(response: Awaited<ReturnType<typeof middleware>>): string | null {
  const location = response.headers.get('location');
  return location ? new URL(location).pathname : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('middleware — account recovery paths', () => {
  it.each(['/forgot-password', '/reset-password'])(
    'serves %s to a signed-out visitor instead of redirecting to /login',
    async (path) => {
      expect(redirectTarget(await middleware(request(path)))).toBeNull();
    },
  );

  it('serves /reset-password with its token query string', async () => {
    const req = new NextRequest(new URL('/reset-password?token=abc123', ORIGIN));
    expect(redirectTarget(await middleware(req))).toBeNull();
  });

  it.each(['/forgot-password', '/reset-password'])(
    'does not bounce a signed-in user away from %s',
    async (path) => {
      expect(redirectTarget(await middleware(request(path, { signedIn: true })))).toBeNull();
    },
  );

  it('still bounces a signed-in user away from /login', async () => {
    expect(redirectTarget(await middleware(request('/login', { signedIn: true })))).toBe(
      '/dashboard',
    );
  });

  it('allows /login when only a refresh cookie remains, preventing a redirect loop', async () => {
    const req = request('/login');
    req.cookies.set(REFRESH_TOKEN_COOKIE, 'a-refresh-token');

    expect(redirectTarget(await middleware(req))).toBeNull();
  });

  it('still gates a protected route for a signed-out visitor', async () => {
    expect(redirectTarget(await middleware(request('/dashboard')))).toBe('/login');
  });
});

describe('middleware — protected session refresh', () => {
  it('rotates a refresh-only session and repeats the protected request with fresh cookies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          data: { accessToken: 'fresh-access-token', refreshToken: 'fresh-refresh-token' },
        }),
      ),
    );
    const req = request('/dashboard?tab=analytics');
    req.cookies.set(REFRESH_TOKEN_COOKIE, 'old-refresh-token');

    const response = await middleware(req);

    expect(response.headers.get('location')).toBe('https://app.test/dashboard?tab=analytics');
    expect(response.cookies.get(ACCESS_TOKEN_COOKIE)?.value).toBe('fresh-access-token');
    expect(response.cookies.get(REFRESH_TOKEN_COOKIE)?.value).toBe('fresh-refresh-token');
  });

  it('clears an invalid refresh-only session and redirects to login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid.' },
          },
          { status: 401 },
        ),
      ),
    );
    const req = request('/dashboard');
    req.cookies.set(REFRESH_TOKEN_COOKIE, 'invalid-refresh-token');

    const response = await middleware(req);

    expect(redirectTarget(response)).toBe('/login');
    expect(response.cookies.get(REFRESH_TOKEN_COOKIE)?.value).toBe('');
  });
});
