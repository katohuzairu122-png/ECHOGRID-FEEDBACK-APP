'use server';

import { redirect } from 'next/navigation';
import type { CustomerAuthResponse } from '@echo-grid-feedback/shared-types';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { setCustomerSession, clearCustomerSession } from '@/lib/customer-session';

export interface OtpRequestState {
  error?: string;
  sent?: boolean;
  phone?: string;
}

export interface OtpVerifyState {
  error?: string;
}

/**
 * Step 1 of customer sign-in: request an SMS code. Always resolves to
 * `sent: true` on success (the underlying API is deliberately silent on
 * whether the phone is a known customer -- see CustomerAuthService.requestOtp)
 * so this action has nothing to leak either; `phone` is echoed back so the
 * client component can move to the code-entry step without re-typing it.
 */
export async function requestOtpAction(
  _prevState: OtpRequestState,
  formData: FormData,
): Promise<OtpRequestState> {
  const phone = String(formData.get('phone') ?? '').trim();

  try {
    await publicApiFetch('/customer-auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  return { sent: true, phone };
}

/**
 * Step 2: verify the code and establish a customer session. `next` (a
 * hidden form field, defaulting to /loyalty/dashboard) lets callers send a
 * customer back to whatever they were doing -- e.g. checking in at a
 * specific branch's QR page -- instead of always landing on the generic
 * dashboard after verifying.
 */
export async function verifyOtpAction(
  _prevState: OtpVerifyState,
  formData: FormData,
): Promise<OtpVerifyState> {
  const phone = String(formData.get('phone') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim();
  const next = String(formData.get('next') ?? '/loyalty/dashboard');

  let result: CustomerAuthResponse;
  try {
    result = await publicApiFetch<CustomerAuthResponse>('/customer-auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  await setCustomerSession(result.accessToken);
  redirect(next);
}

export async function customerLogoutAction(): Promise<void> {
  await clearCustomerSession();
  redirect('/loyalty/login');
}
