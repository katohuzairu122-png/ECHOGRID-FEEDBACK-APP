'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { API_BASE_URL } from '@/lib/api-client';
import { signedAttributionHeadersSafe } from '@/lib/cashier/client-attribution';
import { callCustomerAuthApi } from '@/lib/customer-email-auth-client';
import { clearCompatibleCustomerSession, getCustomerToken, hasRotatingRefreshCredential } from '@/lib/customer-session';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export type CustomerDeletionStatus = { status: 'none' } | {
  status: 'pending'; requestedAt: string; scheduledFor: string;
};
export type CustomerDeletionState = { error?: 'invalid' | 'rate_limited' | 'unavailable' };

export const isCustomerDeletionWebEnabled = () =>
  process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' &&
  process.env.CUSTOMER_DELETION_ENABLED === 'true';

/** These API routes return raw JSON, unlike ordinary customerApiFetch envelopes. */
async function callDeletionGet(token: string): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
  for (const [name, value] of Object.entries(await signedAttributionHeadersSafe())) headers.set(name, value);
  return fetch(`${API_BASE_URL}/api/v1/customer-account/deletion`, {
    headers, cache: 'no-store', redirect: 'manual',
  });
}

export async function getCustomerDeletionStatus(): Promise<CustomerDeletionStatus> {
  if (!isCustomerDeletionWebEnabled()) return { status: 'none' };
  const token = await getCustomerToken();
  if (!token) redirect('/loyalty/session/refresh?next=%2Floyalty%2Fdeletion%2Fpending');
  const response = await callDeletionGet(token);
  if (response.status === 401) {
    redirect((await hasRotatingRefreshCredential())
      ? '/loyalty/session/refresh?next=%2Floyalty%2Fdeletion%2Fpending'
      : '/loyalty/login?next=%2Floyalty%2Fdeletion%2Fpending');
  }
  if (!response.ok) throw new Error('Customer deletion status is unavailable');
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('Invalid deletion status');
  const value = payload as Record<string, unknown>;
  if (value.status === 'none') return { status: 'none' };
  if (value.status === 'pending' && typeof value.requestedAt === 'string' &&
      typeof value.scheduledFor === 'string') {
    return { status: 'pending', requestedAt: value.requestedAt, scheduledFor: value.scheduledFor };
  }
  throw new Error('Invalid deletion status');
}

export async function requestCustomerDeletionAction(
  _previous: CustomerDeletionState,
  formData: FormData,
): Promise<CustomerDeletionState> {
  if (!isCustomerDeletionWebEnabled()) return { error: 'unavailable' };
  const password = formData.get('currentPassword');
  const confirmed = formData.get('confirmed') === 'yes';
  if (!confirmed || typeof password !== 'string' || !password || password.length > 1024)
    return { error: 'invalid' };
  const token = await getCustomerToken();
  if (!token) return { error: 'unavailable' };
  try {
    const verified = await callCustomerAuthApi('/customer-account/deletion/reauth', {
      bearer: token, body: { currentPassword: password },
    });
    if (verified.status === 429) return { error: 'rate_limited' };
    if (verified.status === 401 || verified.status === 400) return { error: 'invalid' };
    if (verified.status !== 204) return { error: 'unavailable' };
    const filed = await callCustomerAuthApi('/customer-account/deletion', { bearer: token });
    if (filed.status !== 201 && filed.status !== 200) return { error: 'unavailable' };
    await clearCompatibleCustomerSession();
  } catch (error) {
    rethrowControlFlow(error);
    return { error: 'unavailable' };
  }
  redirect('/loyalty/login?next=%2Floyalty%2Fdeletion%2Fpending');
}

export async function restoreCustomerDeletionAction(
  _previous: CustomerDeletionState,
  _formData: FormData,
): Promise<CustomerDeletionState> {
  if (!isCustomerDeletionWebEnabled()) return { error: 'unavailable' };
  const token = await getCustomerToken();
  if (!token) return { error: 'unavailable' };
  try {
    const restored = await callCustomerAuthApi('/customer-account/deletion/restore', { bearer: token });
    if (restored.status !== 200) return { error: 'unavailable' };
    revalidatePath('/loyalty/dashboard');
  } catch (error) {
    rethrowControlFlow(error);
    return { error: 'unavailable' };
  }
  redirect('/loyalty/dashboard');
}
