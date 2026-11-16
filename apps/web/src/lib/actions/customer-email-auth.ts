'use server';

import { redirect } from 'next/navigation';
import { callCustomerAuthApi, isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { readRefreshResponse } from '@/lib/customer-session-bff';
import { setRotatingCustomerSession } from '@/lib/customer-session';
import { revokeRotatingCustomerSession } from '@/lib/customer-session-refresh';
import { safeInternalPath } from '@/lib/safe-redirect';

/**
 * Email sign-up and sign-in (CUSTOMER-AUTH-S5-03). Errors are CODES, not English text, so the screens translate them and no
 * message can leak whether an email is registered: sign-in failures are all `invalid_credentials`, sign-up always answers
 * "sent". Credentials returned by the API go straight into HttpOnly host-only cookies and never into a response body.
 */
export type EmailAuthErrorCode = 'invalid_input' | 'invalid_credentials' | 'invalid_proof' | 'rate_limited' | 'unavailable';

export interface EmailAuthState {
  error?: EmailAuthErrorCode;
  sent?: boolean;
  success?: boolean;
  next?: string;
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function codeFor(status: number, mapping: Partial<Record<number, EmailAuthErrorCode>>): EmailAuthErrorCode {
  return mapping[status] ?? (status === 429 ? 'rate_limited' : status === 400 ? 'invalid_input' : 'unavailable');
}

/** Step 1 of sign-up: ask for a confirmation email. Always `sent` for a well-formed address (no enumeration). */
export async function requestEmailRegistrationAction(_prev: EmailAuthState, formData: FormData): Promise<EmailAuthState> {
  if (!isCustomerEmailAuthWebEnabled()) return { error: 'unavailable' };
  const email = text(formData, 'email').toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { error: 'invalid_input' };
  try {
    const reply = await callCustomerAuthApi('/customer-auth/email/register/request', { body: { email } });
    return reply.status === 202 ? { sent: true } : { error: codeFor(reply.status, {}) };
  } catch {
    return { error: 'unavailable' };
  }
}

async function signIn(email: string, password: string): Promise<EmailAuthErrorCode | null> {
  const reply = await callCustomerAuthApi('/customer-auth/email/login', { body: { email, password } });
  if (reply.status !== 200) return codeFor(reply.status, { 401: 'invalid_credentials' });
  const credentials = readRefreshResponse(reply.body);
  if (!credentials) return 'unavailable';
  await setRotatingCustomerSession(credentials);
  return null;
}

/**
 * Step 2 of sign-up: the confirmation link carries `challengeId.proof` in its URL fragment (read client-side and submitted
 * here). On success the customer is signed in. The API cannot tell a bad proof from a weak password (one generic 401), so
 * both are `invalid_proof`.
 */
export async function completeEmailRegistrationAction(_prev: EmailAuthState, formData: FormData): Promise<EmailAuthState> {
  if (!isCustomerEmailAuthWebEnabled()) return { error: 'unavailable' };
  const email = text(formData, 'email').toLowerCase();
  const password = String(formData.get('password') ?? '');
  const [challengeId = '', proof = ''] = text(formData, 'challenge').split('.');
  // Optional, stored by the API as an UNVERIFIED claim; it gates nothing until the phone-verification flow proves it.
  const phone = text(formData, 'phone');
  const next = safeInternalPath(String(formData.get('next') ?? '/loyalty/dashboard'), '/loyalty/dashboard');
  if (!EMAIL.test(email) || !challengeId || !proof || password.length === 0) return { error: 'invalid_input' };
  try {
    const reply = await callCustomerAuthApi('/customer-auth/email/register/complete', {
      body: { email, challengeId, proof, password, ...(phone ? { phone } : {}) },
    });
    if (reply.status !== 201) return { error: codeFor(reply.status, { 401: 'invalid_proof' }) };
    const failure = await signIn(email, password);
    return failure ? { error: failure } : { success: true, next };
  } catch {
    return { error: 'unavailable' };
  }
}

/** Email and password sign-in. Returns only after the cookies are set; the client then navigates with a fresh document load. */
export async function loginWithEmailAction(_prev: EmailAuthState, formData: FormData): Promise<EmailAuthState> {
  if (!isCustomerEmailAuthWebEnabled()) return { error: 'unavailable' };
  const email = text(formData, 'email').toLowerCase();
  const password = String(formData.get('password') ?? '');
  const next = safeInternalPath(String(formData.get('next') ?? '/loyalty/dashboard'), '/loyalty/dashboard');
  if (!EMAIL.test(email) || password.length === 0) return { error: 'invalid_credentials' };
  try {
    const failure = await signIn(email, password);
    return failure ? { error: failure } : { success: true, next };
  } catch {
    return { error: 'unavailable' };
  }
}

/** Revokes a rotating session on the server (best effort) and always clears this device's cookies. */
export async function endRotatingCustomerSessionAction(): Promise<void> {
  await revokeRotatingCustomerSession();
  redirect('/loyalty/login');
}
