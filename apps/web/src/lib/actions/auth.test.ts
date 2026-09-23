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

import {
  logoutAction,
  requestPasswordResetAction,
  resetPasswordAction,
} from './auth';

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
