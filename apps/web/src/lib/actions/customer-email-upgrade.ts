'use server';

import { callCustomerAuthApi, isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { clearCompatibleCustomerSession, getCompatibleCustomerCredentials } from '@/lib/customer-session';
import { getCustomerPasswordMinLength, passwordLength } from '@/lib/customer-password-policy';

export type CustomerEmailUpgradeState = {
  sent?: true;
  success?: true;
  error?: 'invalid' | 'password_mismatch' | 'password_too_short' | 'verify_phone_again' | 'unavailable' | 'rate_limited';
  minLength?: number;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const input = (data: FormData, field: string) => String(data.get(field) ?? '').trim();

async function otpSessionAccessToken(): Promise<string | null> {
  const current = await getCompatibleCustomerCredentials();
  return current.kind === 'rotating' ? current.accessToken ?? null : null;
}

/**
 * Requires a live rotating OTP session, issued only after a fresh verified phone OTP.
 * A legacy 90-day bearer cannot request credential linking.
 */
export async function requestCustomerEmailUpgradeAction(
  _prev: CustomerEmailUpgradeState, data: FormData,
): Promise<CustomerEmailUpgradeState> {
  if (!isCustomerEmailAuthWebEnabled() || process.env.CUSTOMER_LEGACY_UPGRADE_ENABLED !== 'true') return { error: 'unavailable' };
  const email = input(data, 'email').toLowerCase();
  if (!emailPattern.test(email) || email.length > 254) return { error: 'invalid' };
  const token = await otpSessionAccessToken();
  if (!token) return { error: 'verify_phone_again' };
  try {
    const reply = await callCustomerAuthApi('/customer-auth/email/link/request', {
      bearer: token, body: { email },
    });
    if (reply.status === 202) return { sent: true };
    if (reply.status === 401) return { error: 'verify_phone_again' };
    if (reply.status === 429) return { error: 'rate_limited' };
    return { error: 'unavailable' };
  } catch { return { error: 'unavailable' }; }
}

/**
 * The email proof is in the URL fragment, not the query string. The existing
 * link service requires BOTH this proof and the SAME live, fresh-step-up OTP
 * session; it atomically links the verified email and revokes all sessions.
 */
export async function completeCustomerEmailUpgradeAction(
  _prev: CustomerEmailUpgradeState, data: FormData,
): Promise<CustomerEmailUpgradeState> {
  if (!isCustomerEmailAuthWebEnabled() || process.env.CUSTOMER_LEGACY_UPGRADE_ENABLED !== 'true') return { error: 'unavailable' };
  const email = input(data, 'email').toLowerCase();
  const password = String(data.get('password') ?? '');
  const confirmation = String(data.get('passwordConfirmation') ?? '');
  const [challengeId = '', proof = ''] = input(data, 'challenge').split('.');
  if (!emailPattern.test(email) || email.length > 254 || !challengeId || !proof || !password) return { error: 'invalid' };
  if (password !== confirmation) return { error: 'password_mismatch' };
  const minLength = getCustomerPasswordMinLength();
  if (minLength !== null && passwordLength(password) < minLength) return { error: 'password_too_short', minLength };
  const token = await otpSessionAccessToken();
  if (!token) return { error: 'verify_phone_again' };
  try {
    const reply = await callCustomerAuthApi('/customer-auth/email/link/complete', {
      bearer: token, body: { email, challengeId, proof, password },
    });
    if (reply.status === 204) {
      await clearCompatibleCustomerSession();
      return { success: true };
    }
    if (reply.status === 401) return { error: 'invalid' };
    if (reply.status === 429) return { error: 'rate_limited' };
    return { error: 'unavailable' };
  } catch { return { error: 'unavailable' }; }
}
