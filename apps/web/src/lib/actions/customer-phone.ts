'use server';

import { ApiError } from '@/lib/api-client';
import { customerApiFetch } from '@/lib/customer-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { safeInternalPath } from '@/lib/safe-redirect';

/**
 * Phone verification for the signed-in customer (CUSTOMER-PHONE-01 stage 4). Errors are CODES the screen translates; none
 * reveals more than the API already decided to say. The customer is the session's, never a field of the request.
 */
export type PhoneErrorCode =
  | 'invalid_phone' | 'invalid_code' | 'locked' | 'cooldown' | 'taken' | 'limited'
  | 'already_verified' | 'change_unsupported' | 'unavailable';

export interface PhoneState {
  error?: PhoneErrorCode;
  sent?: boolean;
  phone?: string;
  verified?: boolean;
  next?: string;
}

const PATH = '/loyalty/dashboard/phone';

function phoneErrorCode(err: unknown): PhoneErrorCode {
  if (!(err instanceof ApiError)) return 'unavailable';
  switch (err.code) {
    case 'INVALID_PHONE': return 'invalid_phone';
    case 'OTP_INVALID': return 'invalid_code';
    case 'OTP_MAX_ATTEMPTS': return 'locked';
    case 'OTP_COOLDOWN': return 'cooldown';
    case 'PHONE_TAKEN': return 'taken';
    case 'PHONE_ATTACH_LIMITED':
    case 'RATE_LIMITED': return 'limited';
    case 'PHONE_ALREADY_VERIFIED': return 'already_verified';
    case 'PHONE_CHANGE_NOT_SUPPORTED': return 'change_unsupported';
    default: return 'unavailable';
  }
}

/** Step 1: text a code to the number. */
export async function requestPhoneCodeAction(_prev: PhoneState, formData: FormData): Promise<PhoneState> {
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) return { error: 'invalid_phone' };
  try {
    await customerApiFetch('/loyalty/me/phone/request', { method: 'POST', body: JSON.stringify({ phone }) }, PATH);
    return { sent: true, phone };
  } catch (err) {
    rethrowControlFlow(err);
    return { error: phoneErrorCode(err), phone };
  }
}

/** Step 2: check the code. On success the number is this customer's verified phone. */
export async function verifyPhoneCodeAction(_prev: PhoneState, formData: FormData): Promise<PhoneState> {
  const phone = String(formData.get('phone') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim();
  const next = safeInternalPath(String(formData.get('next') ?? '/loyalty/dashboard'), '/loyalty/dashboard');
  if (!phone || !code) return { error: 'invalid_code', sent: true, phone };
  try {
    await customerApiFetch('/loyalty/me/phone/verify', { method: 'POST', body: JSON.stringify({ phone, code }) }, PATH);
    return { verified: true, next };
  } catch (err) {
    rethrowControlFlow(err);
    // Keep the code step open for a wrong or expired code so the customer can retry or ask for a new one.
    return { error: phoneErrorCode(err), sent: true, phone };
  }
}
