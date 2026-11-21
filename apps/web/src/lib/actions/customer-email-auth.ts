'use server';

import { redirect } from 'next/navigation';
import { callCustomerAuthApi, isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { readRefreshResponse } from '@/lib/customer-session-bff';
import { setRotatingCustomerSession } from '@/lib/customer-session';
import { revokeRotatingCustomerSession } from '@/lib/customer-session-refresh';
import { safeInternalPath } from '@/lib/safe-redirect';
import { getCustomerPasswordMinLength, passwordLength } from '@/lib/customer-password-policy';
import { logEmailAuthWebUnavailable, type EmailAuthWebAction } from '@/lib/customer-email-auth-diagnostics';

/**
 * Email sign-up and sign-in (CUSTOMER-AUTH-S5-03). Errors are CODES, not English text, so the screens translate them and no
 * message can leak whether an email is registered: sign-in failures are all `invalid_credentials`, sign-up always answers
 * "sent". Credentials returned by the API go straight into HttpOnly host-only cookies and never into a response body.
 */
export type EmailAuthErrorCode =
  | 'invalid_input' | 'invalid_credentials' | 'invalid_proof' | 'password_too_short' | 'password_mismatch' | 'rate_limited' | 'unavailable';

export interface EmailAuthState {
  error?: EmailAuthErrorCode;
  sent?: boolean;
  success?: boolean;
  next?: string;
  /** With `password_too_short`: the configured minimum, so the screen can say it. */
  minLength?: number;
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function codeFor(status: number, mapping: Partial<Record<number, EmailAuthErrorCode>>): EmailAuthErrorCode {
  return mapping[status] ?? (status === 429 ? 'rate_limited' : status === 400 ? 'invalid_input' : 'unavailable');
}

/** Passes the code through; when it is the generic "unavailable", records which status caused it. */
function unmappedLogged(code: EmailAuthErrorCode, action: EmailAuthWebAction, status: number): EmailAuthErrorCode {
  if (code === 'unavailable') logEmailAuthWebUnavailable('api_unexpected_status', { action, status });
  return code;
}

/** Step 1 of sign-up: ask for a confirmation email. Always `sent` for a well-formed address (no enumeration). */
export async function requestEmailRegistrationAction(_prev: EmailAuthState, formData: FormData): Promise<EmailAuthState> {
  if (!isCustomerEmailAuthWebEnabled()) {
    logEmailAuthWebUnavailable('web_flag_disabled', { action: 'register_request' });
    return { error: 'unavailable' };
  }
  const email = text(formData, 'email').toLowerCase();
  const name = text(formData, 'name');
  const password = String(formData.get('password') ?? '');
  const passwordConfirmation = String(formData.get('passwordConfirmation') ?? '');
  if (!EMAIL.test(email) || email.length > 254 || !name || name.length > 120 || password.length === 0) return { error: 'invalid_input' };
  if (password !== passwordConfirmation) return { error: 'password_mismatch' };
  const minLength = getCustomerPasswordMinLength();
  if (minLength !== null && passwordLength(password) < minLength) return { error: 'password_too_short', minLength };
  const next = safeInternalPath(String(formData.get('next') ?? '/loyalty/dashboard'), '/loyalty/dashboard');
  try {
    // The registration request only sends the email. The name and raw password are never sent before proof,
    // persisted, logged, put in a URL, or included in the confirmation email.
    const reply = await callCustomerAuthApi('/customer-auth/email/register/request', { body: { email, next } });
    if (reply.status === 202) return { sent: true };
    return { error: unmappedLogged(codeFor(reply.status, {}), 'register_request', reply.status) };
  } catch (error) {
    logEmailAuthWebUnavailable('api_fetch_failed', { action: 'register_request', error });
    return { error: 'unavailable' };
  }
}

async function signIn(email: string, password: string, action: EmailAuthWebAction): Promise<EmailAuthErrorCode | null> {
  const reply = await callCustomerAuthApi('/customer-auth/email/login', { body: { email, password } });
  if (reply.status !== 200) return unmappedLogged(codeFor(reply.status, { 401: 'invalid_credentials' }), action, reply.status);
  const credentials = readRefreshResponse(reply.body);
  if (!credentials) {
    logEmailAuthWebUnavailable('api_response_unreadable', { action });
    return 'unavailable';
  }
  await setRotatingCustomerSession(credentials);
  return null;
}

/**
 * Step 2 of sign-up: the confirmation link carries `challengeId.proof` in its URL fragment (read client-side and submitted
 * here). On success the customer is signed in. The API cannot tell a bad proof from a weak password (one generic 401), so
 * both are `invalid_proof`.
 */
export async function completeEmailRegistrationAction(_prev: EmailAuthState, formData: FormData): Promise<EmailAuthState> {
  if (!isCustomerEmailAuthWebEnabled()) {
    logEmailAuthWebUnavailable('web_flag_disabled', { action: 'register_complete' });
    return { error: 'unavailable' };
  }
  const email = text(formData, 'email').toLowerCase();
  const name = text(formData, 'name');
  const password = String(formData.get('password') ?? '');
  const passwordConfirmation = String(formData.get('passwordConfirmation') ?? '');
  const [challengeId = '', proof = ''] = text(formData, 'challenge').split('.');
  // Optional, stored by the API as an UNVERIFIED claim; it gates nothing until the phone-verification flow proves it.
  const phone = text(formData, 'phone');
  const next = safeInternalPath(String(formData.get('next') ?? '/loyalty/dashboard'), '/loyalty/dashboard');
  if (!EMAIL.test(email) || !challengeId || !proof || !name || name.length > 120 || password.length === 0) return { error: 'invalid_input' };
  if (password !== passwordConfirmation) return { error: 'password_mismatch' };
  // Refuse an obviously short password before the proof is spent. The configured minimum only; the API remains authoritative
  // (and fails closed if it has no minimum of its own), so an unset value here simply skips this early, friendlier check.
  const minLength = getCustomerPasswordMinLength();
  if (minLength !== null && passwordLength(password) < minLength) return { error: 'password_too_short', minLength };
  try {
    const reply = await callCustomerAuthApi('/customer-auth/email/register/complete', {
      body: { email, challengeId, proof, name, password, ...(phone ? { phone } : {}) },
    });
    if (reply.status !== 201) return { error: unmappedLogged(codeFor(reply.status, { 401: 'invalid_proof' }), 'register_complete', reply.status) };
    const failure = await signIn(email, password, 'register_complete');
    return failure ? { error: failure } : { success: true, next };
  } catch (error) {
    logEmailAuthWebUnavailable('api_fetch_failed', { action: 'register_complete', error });
    return { error: 'unavailable' };
  }
}

/** Email and password sign-in. Returns only after the cookies are set; the client then navigates with a fresh document load. */
export async function loginWithEmailAction(_prev: EmailAuthState, formData: FormData): Promise<EmailAuthState> {
  if (!isCustomerEmailAuthWebEnabled()) {
    logEmailAuthWebUnavailable('web_flag_disabled', { action: 'login' });
    return { error: 'unavailable' };
  }
  const email = text(formData, 'email').toLowerCase();
  const password = String(formData.get('password') ?? '');
  const next = safeInternalPath(String(formData.get('next') ?? '/loyalty/dashboard'), '/loyalty/dashboard');
  if (!EMAIL.test(email) || password.length === 0) return { error: 'invalid_credentials' };
  try {
    const failure = await signIn(email, password, 'login');
    return failure ? { error: failure } : { success: true, next };
  } catch (error) {
    logEmailAuthWebUnavailable('api_fetch_failed', { action: 'login', error });
    return { error: 'unavailable' };
  }
}

/** Revokes a rotating session on the server (best effort) and always clears this device's cookies. */
export async function endRotatingCustomerSessionAction(): Promise<void> {
  await revokeRotatingCustomerSession();
  redirect('/loyalty/login');
}
