'use server';

import { redirect } from 'next/navigation';
import { setSession, getRefreshToken, clearSession } from '@/lib/session';
import { API_BASE_URL } from '@/lib/api-client';

export interface AuthActionState {
  error?: string;
}

/**
 * Login/signup call the Hono API directly (not through apiFetch) -- there's
 * no access token yet at this point, so apiFetch's auth-header/refresh
 * machinery doesn't apply. Both convert the token-pair response into
 * httpOnly cookies via setSession(); the browser that submitted the form
 * never sees accessToken/refreshToken in any response body.
 */
async function callAuthEndpoint(
  path: 'login' | 'signup',
  body: Record<string, string>,
): Promise<AuthActionState> {
  const response = await fetch(`${API_BASE_URL}/api/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as {
    success?: boolean;
    data: { accessToken: string; refreshToken: string };
    error?: { message?: string };
  };

  if (!response.ok || !result.success) {
    return { error: result.error?.message ?? 'Something went wrong. Please try again.' };
  }

  await setSession(result.data);
  return {};
}

export async function loginAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await callAuthEndpoint('login', { email, password });
  if (result.error) return result;

  redirect('/dashboard');
}

export async function signupAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const fullName = String(formData.get('fullName') ?? '');

  const result = await callAuthEndpoint('signup', { email, password, fullName });
  if (result.error) return result;

  redirect('/dashboard');
}

/**
 * Best-effort upstream revoke: the local session is cleared regardless of
 * whether the API call succeeds, so a network blip never traps a user in a
 * logged-in-looking state they can't escape.
 */
export async function logoutAction(): Promise<void> {
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    await fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => null);
  }
  await clearSession();
  redirect('/login');
}
