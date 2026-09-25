import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getRefreshTokenForLogoutMock,
  clearSessionMock,
  redirectMock,
  apiFetchMock,
} = vi.hoisted(() => ({
  getRefreshTokenForLogoutMock: vi.fn(),
  clearSessionMock: vi.fn(),
  redirectMock: vi.fn(),
  apiFetchMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  getRefreshTokenForLogout: getRefreshTokenForLogoutMock,
  clearSession: clearSessionMock,
  setSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

vi.mock('@/lib/api-client', () => {
  class MockApiError extends Error {
    status: number;
    code: string | undefined;

    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  return {
    API_BASE_URL: 'https://api.example.test',
    apiFetch: apiFetchMock,
    ApiError: MockApiError,
  };
});

import { ApiError } from '@/lib/api-client';
import {
  changePasswordAction,
  logoutAction,
  requestPasswordResetAction,
  resetPasswordAction,
} from './auth';

describe('logoutAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('preserves the local session when the logout request cannot reach the API', async () => {
    getRefreshTokenForLogoutMock.mockResolvedValue('refresh-token');
    vi.mocked(fetch).mockRejectedValue(new Error('network failure'));

    await expect(logoutAction()).rejects.toThrow(
      'Unable to sign out safely. Please try again.',
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-token' }),
      }),
    );
    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('preserves the local session when the API does not confirm revocation', async () => {
    getRefreshTokenForLogoutMock.mockResolvedValue('refresh-token');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

    await expect(logoutAction()).rejects.toThrow(
      'Unable to sign out safely. Please try again.',
    );

    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('clears the local session and redirects after revocation succeeds', async () => {
    getRefreshTokenForLogoutMock.mockResolvedValue('refresh-token');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await logoutAction();

    expect(clearSessionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('clears the local session without calling the API when no refresh token exists', async () => {
    getRefreshTokenForLogoutMock.mockResolvedValue(null);

    await logoutAction();

    expect(fetch).not.toHaveBeenCalled();
    expect(clearSessionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('revokes the stashed administrator credential before ending impersonation', async () => {
    getRefreshTokenForLogoutMock.mockResolvedValue('stashed-admin-refresh-token');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await logoutAction();

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/logout',
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: 'stashed-admin-refresh-token' }),
      }),
    );
    expect(clearSessionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('preserves the impersonation and administrator stash when revocation fails', async () => {
    getRefreshTokenForLogoutMock.mockResolvedValue('stashed-admin-refresh-token');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

    await expect(logoutAction()).rejects.toThrow(
      'Unable to sign out safely. Please try again.',
    );

    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe('password recovery actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns generic submitted success for an accepted reset request', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 202 }),
    );

    const formData = new FormData();
    formData.set('email', 'user@example.com');

    await expect(
      requestPasswordResetAction({}, formData),
    ).resolves.toEqual({ submitted: true });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/password-reset/request',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com' }),
      }),
    );
  });

  it('rejects mismatched passwords before calling the API', async () => {
    const formData = new FormData();
    formData.set('token', 'reset-token');
    formData.set('newPassword', 'first-password-123');
    formData.set('confirmPassword', 'second-password-123');

    await expect(
      resetPasswordAction({}, formData),
    ).resolves.toEqual({
      error: 'Passwords do not match.',
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards the reset token and new password on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const formData = new FormData();
    formData.set('token', 'reset-token');
    formData.set('newPassword', 'brand-new-password-123');
    formData.set('confirmPassword', 'brand-new-password-123');

    await expect(
      resetPasswordAction({}, formData),
    ).resolves.toEqual({ success: true });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/password-reset/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'reset-token',
          newPassword: 'brand-new-password-123',
        }),
      }),
    );
  });

  it('surfaces an API reset error instead of reporting success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'This reset link is invalid or has expired.',
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const formData = new FormData();
    formData.set('token', 'expired-token');
    formData.set('newPassword', 'brand-new-password-123');
    formData.set('confirmPassword', 'brand-new-password-123');

    await expect(
      resetPasswordAction({}, formData),
    ).resolves.toEqual({
      error: 'This reset link is invalid or has expired.',
    });
  });
});

describe('changePasswordAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects mismatched new passwords before calling the API', async () => {
    const formData = new FormData();
    formData.set('currentPassword', 'current-password-123');
    formData.set('newPassword', 'new-password-123');
    formData.set('confirmPassword', 'different-password-123');

    await expect(
      changePasswordAction({}, formData),
    ).resolves.toEqual({
      error: 'Passwords do not match.',
    });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('sends the current and new passwords to the authenticated API endpoint', async () => {
    apiFetchMock.mockResolvedValue(undefined);

    const formData = new FormData();
    formData.set('currentPassword', 'current-password-123');
    formData.set('newPassword', 'brand-new-password-123');
    formData.set('confirmPassword', 'brand-new-password-123');

    await changePasswordAction({}, formData);

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/auth/password/change',
      {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: 'current-password-123',
          newPassword: 'brand-new-password-123',
        }),
      },
    );
  });

  it('clears the local session and redirects to login after a successful password change', async () => {
    apiFetchMock.mockResolvedValue(undefined);

    const formData = new FormData();
    formData.set('currentPassword', 'current-password-123');
    formData.set('newPassword', 'brand-new-password-123');
    formData.set('confirmPassword', 'brand-new-password-123');

    await changePasswordAction({}, formData);

    expect(clearSessionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('surfaces an API error without clearing the existing session', async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError('Current password is incorrect.', 401, 'INVALID_CREDENTIALS'),
    );

    const formData = new FormData();
    formData.set('currentPassword', 'wrong-current-password');
    formData.set('newPassword', 'brand-new-password-123');
    formData.set('confirmPassword', 'brand-new-password-123');

    await expect(
      changePasswordAction({}, formData),
    ).resolves.toEqual({
      error: 'Current password is incorrect.',
    });

    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
