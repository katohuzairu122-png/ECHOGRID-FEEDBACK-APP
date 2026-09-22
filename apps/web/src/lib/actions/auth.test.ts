import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getRefreshTokenMock,
  clearSessionMock,
  redirectMock,
} = vi.hoisted(() => ({
  getRefreshTokenMock: vi.fn(),
  clearSessionMock: vi.fn(),
  redirectMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  getRefreshToken: getRefreshTokenMock,
  clearSession: clearSessionMock,
  setSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: 'https://api.example.test',
}));

import { logoutAction } from './auth';

describe('logoutAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('clears the local session and redirects when upstream logout fails', async () => {
    getRefreshTokenMock.mockResolvedValue('refresh-token');
    vi.mocked(fetch).mockRejectedValue(new Error('network failure'));

    await logoutAction();

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-token' }),
      }),
    );
    expect(clearSessionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('clears the local session without calling the API when no refresh token exists', async () => {
    getRefreshTokenMock.mockResolvedValue(null);

    await logoutAction();

    expect(fetch).not.toHaveBeenCalled();
    expect(clearSessionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });
});
