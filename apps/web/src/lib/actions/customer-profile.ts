'use server';

import { customerApiFetch } from '@/lib/customer-api-client';
import { callCustomerAuthApi } from '@/lib/customer-email-auth-client';
import { clearCompatibleCustomerSession, getCustomerToken } from '@/lib/customer-session';
import { redirect } from 'next/navigation';

export type CustomerProfileFormState = { saved?: boolean; error?: 'invalid_name' | 'unavailable' };

export async function updateCustomerProfileAction(
  _previous: CustomerProfileFormState,
  formData: FormData,
): Promise<CustomerProfileFormState> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name || name.length > 120) return { error: 'invalid_name' };
  try {
    await customerApiFetch('/loyalty/me/profile', {
      method: 'PATCH', body: JSON.stringify({ name }),
    });
    return { saved: true };
  } catch {
    return { error: 'unavailable' };
  }
}

export type CustomerPasswordChangeState = { saved?: true; error?: 'invalid' | 'unavailable' };

export async function changeCustomerPasswordAction(
  _previous: CustomerPasswordChangeState,
  formData: FormData,
): Promise<CustomerPasswordChangeState> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');
  if (!currentPassword || !newPassword || newPassword !== confirmPassword) return { error: 'invalid' };
  const token = await getCustomerToken();
  if (!token) return { error: 'unavailable' };
  try {
    const result = await callCustomerAuthApi('/customer-auth/email/password/change', {
      bearer: token,
      body: { currentPassword, newPassword },
    });
    if (result.status === 401 || result.status === 400) return { error: 'invalid' };
    if (result.status !== 204) return { error: 'unavailable' };
    await clearCompatibleCustomerSession();
  } catch {
    return { error: 'unavailable' };
  }
  redirect('/loyalty/login?password=changed');
}

export async function logoutCustomerEverywhereAction(): Promise<void> {
  const token = await getCustomerToken();
  if (token) {
    try {
      await callCustomerAuthApi('/customer-session/logout-all', { bearer: token });
    } catch {
      // Cookie deletion still signs out this device if the API is unavailable.
    }
  }
  await clearCompatibleCustomerSession();
  redirect('/loyalty/login');
}
