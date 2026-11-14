'use server';

import { revalidatePath } from 'next/cache';
import type { PlatformCustomerDetailDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';

export interface CustomerSanctionState {
  error?: string;
  success?: boolean;
}

const MAX_DAYS = 365;

/**
 * Warn, suspend (for a number of days), ban or lift. The server enforces the
 * real rules (admin only, a warning before a suspension or ban, the maximum
 * period); this only builds the request.
 */
export async function applyCustomerSanctionAction(
  customerId: string,
  _prev: CustomerSanctionState,
  formData: FormData,
): Promise<CustomerSanctionState> {
  const action = String(formData.get('action') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const days = Number(formData.get('days') ?? 0);
  const skipWarning = formData.get('skipWarning') === 'on';

  const body: Record<string, unknown> = { action, reason };
  if (action === 'suspend') {
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return { error: `Enter a whole number of days between 1 and ${MAX_DAYS}.` };
    }
    body.suspendedUntil = new Date(Date.now() + days * 86_400_000).toISOString();
  }
  if (skipWarning && (action === 'suspend' || action === 'ban')) body.skipWarning = true;

  try {
    await apiFetch<PlatformCustomerDetailDto>(`/platform/customers/${customerId}/sanctions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`/platform/customers/${customerId}`);
  return { success: true };
}
