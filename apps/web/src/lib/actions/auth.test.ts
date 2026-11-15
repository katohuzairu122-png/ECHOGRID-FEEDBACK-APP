import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getRefreshTokenForLogoutMock,
  clearSessionMock,
  redirectMock,
  apiFetchMock,
  setSessionMock,
  refuseOnCashierHostMock,
  attributionMock,
} = vi.hoisted(() => ({
  getRefreshTokenForLogoutMock: vi.fn(),
  clearSessionMock: vi.fn(),
  redirectMock: vi.fn(),
  apiFetchMock: vi.fn(),
  setSessionMock: vi.fn(),
  refuseOnCashierHostMock: vi.fn(),
  attributionMock: vi.fn(async () => ({}) as Record<string, string>),
}));

vi.mock('@/lib/session', () => ({
  getRefreshTokenForLogout: getRefreshTokenForLogoutMock,
  clearSession: clearSessionMock,
  setSession: setSessionMock,
}));

vi.mock('@/lib/cashier/host-guard', () => ({ refuseOnCashierHost: refuseOnCashierHostMock }));
vi.mock('@/lib/cashier/client-attribution', () => ({ clientAttributionHeaders: attributionMock }));

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
  signupAction,
  loginAction,
} from './auth';

describe('loginAction', () => {
  const credentials = (next = '/dashboard') => {
    const form = new FormData();
    form.set('email', 'user@example.com');
    form.set('password', 'test-password');
    form.set('next', next);
    return form;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });
  it('H3-1: password-reset request and confirm forward the signed client attribution; nothing extra when there is none', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));
    const reqForm = new FormData();
    reqForm.set('email', 'a@example.test');
    attributionMock.mockResolvedValueOnce({ 'x-echo-client': 'v1.signed.value' });
    await requestPasswordResetAction({}, reqForm);
    const first = vi.mocked(fetch).mock.calls[0]!;
    expect(String(first[0])).toContain('/auth/password-reset/request');
    expect(new Headers((first[1] as RequestInit).headers).get('x-echo-client')).toBe('v1.signed.value');
    vi.mocked(fetch).mockClear();
    const confirm = new FormData();
    confirm.set('token', 't'.repeat(64));
    confirm.set('newPassword', 'brand-new-password-1');
    confirm.set('confirmPassword', 'brand-new-password-1');
    attributionMock.mockResolvedValueOnce({ 'x-echo-client': 'v1.signed.value' });
    await resetPasswordAction({}, confirm);
    expect(new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('x-echo-client')).toBe('v1.signed.value');
    vi.mocked(fetch).mockClear();
    await requestPasswordResetAction({}, reqForm);
    expect(new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('x-echo-client')).toBeNull();
  });
  it('STG-SEC-02B: staff login and signup forward the signed client attribution to the API; nothing extra when there is none', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: { accessToken: 'a', refreshToken: 'r' } })));
    attributionMock.mockResolvedValueOnce({ 'x-echo-client': 'v1.signed.value' });
    await loginAction({}, credentials('/dashboard'));
    expect(new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('x-echo-client')).toBe('v1.signed.value');
    vi.mocked(fetch).mockClear();
    await loginAction({}, credentials('/dashboard'));
    expect(new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('x-echo-client')).toBeNull();
  });
  it('SEC-CASHIER-R2b: staff login, signup, password reset and logout never call the API from the cashier origin', async () => {
    refuseOnCashierHostMock.mockRejectedValue(new Error('NEXT_NOT_FOUND'));
    await expect(loginAction({}, credentials('/dashboard'))).rejects.toThrow('NEXT_NOT_FOUND');
    const form = new FormData();
    form.set('email', 'user@example.com');
    form.set('password', 'test-password');
    await expect(signupAction({}, form)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(requestPasswordResetAction({}, form)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(resetPasswordAction({}, form)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(logoutAction()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetch).not.toHaveBeenCalled();
    refuseOnCashierHostMock.mockReset();
  });
  it('uses the existing API, stores the session and preserves an internal redirect', async () => {
    const tokens = { accessToken: 'access-token', refreshToken: 'refresh-token' };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: tokens })),
    );
    await loginAction({}, credentials('/dashboard/branches'));
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: 'test-password' }),
      }),
    );
    expect(setSessionMock).toHaveBeenCalledWith(tokens);
    expect(redirectMock).toHaveBeenCalledWith('/dashboard/branches');
  });
  it.each(['https://evil.test', '//evil.test'])(
    'rejects the external redirect %s',
    async (next) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { accessToken: 'a', refreshToken: 'r' } }),
        ),
      );
      await loginAction({}, credentials(next));
      expect(redirectMock).toHaveBeenCalledWith('/dashboard');
    },
  );
  it('shows authentication denial without creating a session or redirecting', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: { message: 'Invalid email or password.' } }),
        { status: 401 },
      ),
    );
    expect(await loginAction({}, credentials())).toEqual({ error: 'Invalid email or password.' });
    expect(setSessionMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
  it.each(['network', 'invalid-json'])(
    'returns a retryable error for %s failure',
    async (failure) => {
      if (failure === 'network') vi.mocked(fetch).mockRejectedValue(new Error('offline'));
      else vi.mocked(fetch).mockResolvedValue(new Response('Unavailable', { status: 503 }));
      expect(await loginAction({}, credentials())).toEqual({ errorKey: 'unavailable' });
      expect(setSessionMock).not.toHaveBeenCalled();
      expect(redirectMock).not.toHaveBeenCalled();
    },
  );
  it('does not swallow the framework success redirect', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: { accessToken: 'a', refreshToken: 'r' } }),
      ),
    );
    redirectMock.mockImplementationOnce(() => {
      throw new Error('NEXT_REDIRECT');
    });
    await expect(loginAction({}, credentials())).rejects.toThrow('NEXT_REDIRECT');
  });
});

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

describe('signupAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rejects signup when terms have not been accepted', async () => {
    const formData = new FormData();
    formData.set('fullName', 'Test User');
    formData.set('email', 'user@example.com');
    formData.set('password', 'secure-password-123');

    await expect(signupAction({}, formData)).resolves.toEqual({
      error: 'You must accept the Terms of Service and Privacy Policy.',
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits signup after terms are accepted', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { accessToken: 'access-token', refreshToken: 'refresh-token' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const formData = new FormData();
    formData.set('fullName', 'Test User');
    formData.set('email', 'user@example.com');
    formData.set('password', 'secure-password-123');
    formData.set('acceptTerms', 'on');

    await signupAction({}, formData);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/auth/signup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'secure-password-123',
          fullName: 'Test User',
        }),
      }),
    );
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
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
