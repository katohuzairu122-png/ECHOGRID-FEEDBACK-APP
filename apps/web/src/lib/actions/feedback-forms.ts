'use server';

import { revalidatePath } from 'next/cache';
import type { QrCodeDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

export async function createFeedbackFormAction(payload: { name: string; questions: unknown[] }): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;
  await apiFetch('/feedback-forms', { method: 'POST', businessId: business.id, body: JSON.stringify(payload) });
  revalidatePath('/dashboard/feedback/forms');
}

export async function createFeedbackFormVersionAction(formId: string, payload: { name: string; questions: unknown[] }): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;
  await apiFetch(`/feedback-forms/${formId}/versions`, { method: 'POST', businessId: business.id, body: JSON.stringify(payload) });
  revalidatePath('/dashboard/feedback/forms');
}

export interface AssignFeedbackFormState {
  error?: string;
  success?: string;
}

export async function assignFeedbackFormAction(
  branchId: string,
  versionId: string,
  _state: AssignFeedbackFormState,
): Promise<AssignFeedbackFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    const qr = await apiFetch<QrCodeDto>(`/branches/${branchId}/qr-code`, { businessId: business.id });
    await apiFetch('/feedback-forms/assign', {
      method: 'POST', businessId: business.id,
      body: JSON.stringify({ qrCodeId: qr.id, versionId }),
    });
    revalidatePath('/dashboard/feedback/forms');
    return { success: 'Assigned successfully.' };
  } catch (error) {
    return {
      error: error instanceof ApiError ? error.message : 'Could not assign this form. Please try again.',
    };
  }
}

