'use server';

import { revalidatePath } from 'next/cache';
import type { QrCodeDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
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

export async function assignFeedbackFormAction(branchId: string, versionId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;
  const qr = await apiFetch<QrCodeDto>(`/branches/${branchId}/qr-code`, { businessId: business.id });
  await apiFetch('/feedback-forms/assign', {
    method: 'POST', businessId: business.id,
    body: JSON.stringify({ qrCodeId: qr.id, versionId }),
  });
  revalidatePath('/dashboard/feedback/forms');
}

