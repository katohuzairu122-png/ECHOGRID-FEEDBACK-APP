'use server';

import { redirect } from 'next/navigation';
import { setSession, getRefreshToken, clearSession } from '@/lib/session';
import { API_BASE_URL } from '@/lib/api-client';

export interface AuthActionState {
  error?: string;
}

/**
 * State for the two password-recovery forms. Separate from AuthActionState
 * rather than adding optional fields to it: login/signup end in a redirect
 * and have no success state to represent, whereas both of these render one
 * in place. Overloading a single type would leave every consumer handling
 * fields that can never be set for their form.
 */
export interface PasswordResetActionState {
  error?: string;
  /** Set once the request has been accepted. Deliberately does NOT mean "an
   * email was sent" -- the API answers 202 whether or not the address
   * matched an account, and the UI must not imply otherwise. */
  submitted?: boolean;
  /** Set once a password has actually been changed. */
  success?: boolean;
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
 * POSTs to an auth endpoint that answers with an empty body (202/204) and
 * returns only an error message, if any.
 *
 * Separate from callAuthEndpoint above because that one always parses JSON
 * and expects a token pair -- neither is true here. The recovery endpoints
 * deliberately return no body at all: the request endpoint has nothing it
 * can safely say (see below), and the confirm endpoint revokes every
 * session rather than issuing one.
 */
async function callEmptyBodyAuthEndpoint(
  path: string,
  body: Record<string, string>,
): Promise<{ error?: string }> {
  const response = await fetch(`${API_BASE_URL}/api/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.ok) return {};

  // Only read a body on failure -- a success has none, and calling .json()
  // on an empty 204 throws.
  const result = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return { error: result?.error?.message ?? 'Something went wrong. Please try again.' };
}

/**
 * Step 1 of recovery. Returns `submitted: true` for any accepted request,
 * and the UI shows an identical confirmation either way.
 *
 * This is the browser-side half of the API's account-enumeration defence
 * (see POST /auth/password-reset/request). The API is careful to answer 202
 * for unknown addresses; surfacing a "no such account" message here would
 * hand back exactly the oracle it withholds. The only thing that can
 * legitimately fail here is the request never reaching the API at all --
 * a rate-limit rejection or a network error -- which is what `error`
 * carries.
 */
export async function requestPasswordResetAction(
  _prevState: PasswordResetActionState,
  formData: FormData,
): Promise<PasswordResetActionState> {
  const email = String(formData.get('email') ?? '');

  const result = await callEmptyBodyAuthEndpoint('password-reset/request', { email });
  if (result.error) return { error: result.error };

  return { submitted: true };
}

/**
 * Step 2 of recovery. Returns `success: true` rather than redirecting to
 * /login: the reset revokes every session, so the user lands on the login
 * page logged out either way -- and an unexplained bounce back to a login
 * form reads as a failure. An explicit confirmation, then a deliberate
 * click through to log in, is the difference between "it worked" and "did
 * that work?".
 */
export async function resetPasswordAction(
  _prevState: PasswordResetActionState,
  formData: FormData,
): Promise<PasswordResetActionState> {
  const token = String(formData.get('token') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');

  // Checked here as well as in the browser: the client-side comparison is a
  // convenience, and a Server Action is a public HTTP endpoint that can be
  // called without ever rendering the form. Mismatch is caught before the
  // API call so a typo doesn't burn the single-use token.
  if (newPassword !== confirmPassword) {
    return { error: 'Passwords do not match.' };
  }

  const result = await callEmptyBodyAuthEndpoint('password-reset/confirm', {
    token,
    newPassword,
  });
  if (result.error) return { error: result.error };

  return { success: true };
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
