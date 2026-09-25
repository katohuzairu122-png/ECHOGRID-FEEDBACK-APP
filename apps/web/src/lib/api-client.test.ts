import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { getAccessTokenMock, getRefreshTokenMock, setSessionMock, clearSessionMock } = vi.hoisted(
  () => ({
    getAccessTokenMock: vi.fn(),
    getRefreshTokenMock: vi.fn(),
    setSessionMock: vi.fn(),
    clearSessionMock: vi.fn(),
  }),
);

vi.mock('./session', () => ({
  getAccessToken: getAccessTokenMock,
  getRefreshToken: getRefreshTokenMock,
  setSession: setSessionMock,
  clearSession: clearSessionMock,
}));

import { apiFetch } from './api-client';

describe('apiFetch session refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessTokenMock.mockResolvedValue('expired-access-token');
    getRefreshTokenMock.mockResolvedValue('rotating-refresh-token');
  });

  it('shares one refresh-token rotation across concurrent 401 responses', async () => {
    let protectedCalls = 0;
    let refreshCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/auth/refresh')) {
          refreshCalls += 1;
          // Leave the refresh pending long enough for both failed protected
          // calls to join the same in-flight rotation.
          await Promise.resolve();
          return Response.json({
            success: true,
            data: { accessToken: 'fresh-access-token', refreshToken: 'fresh-refresh-token' },
          });
        }

        protectedCalls += 1;
        const authorization = new Headers(init?.headers).get('Authorization');
        if (authorization === 'Bearer expired-access-token') {
          return Response.json(
            { success: false, error: { code: 'INVALID_TOKEN', message: 'Expired.' } },
            { status: 401 },
          );
        }
        return Response.json({ success: true, data: { ok: true } });
      }),
    );

    const [first, second] = await Promise.all([
      apiFetch<{ ok: boolean }>('/branches'),
      apiFetch<{ ok: boolean }>('/analytics/trends'),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(protectedCalls).toBe(4);
    expect(setSessionMock).toHaveBeenCalledTimes(2);
    expect(setSessionMock).toHaveBeenCalledWith({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
    });
    expect(clearSessionMock).not.toHaveBeenCalled();
  });

  it('does not clear cookies when another Worker isolate already rotated the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/v1/auth/refresh')) {
          return Response.json(
            {
              success: false,
              error: {
                code: 'REFRESH_TOKEN_ROTATED',
                message: 'Refresh token was already rotated by a concurrent request.',
              },
            },
            { status: 409 },
          );
        }
        return Response.json(
          { success: false, error: { code: 'INVALID_TOKEN', message: 'Expired.' } },
          { status: 401 },
        );
      }),
    );

    await expect(apiFetch('/branches')).rejects.toMatchObject({ status: 401 });

    expect(setSessionMock).not.toHaveBeenCalled();
    expect(clearSessionMock).not.toHaveBeenCalled();
  });

  it('still clears cookies when refresh is genuinely invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/v1/auth/refresh')) {
          return Response.json(
            {
              success: false,
              error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid.' },
            },
            { status: 401 },
          );
        }
        return Response.json(
          { success: false, error: { code: 'INVALID_TOKEN', message: 'Expired.' } },
          { status: 401 },
        );
      }),
    );

    await expect(apiFetch('/branches')).rejects.toMatchObject({ status: 401 });

    expect(clearSessionMock).toHaveBeenCalledOnce();
  });
});
