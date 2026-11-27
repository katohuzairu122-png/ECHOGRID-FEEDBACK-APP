'use server';

import { revalidatePath } from 'next/cache';
import { ApiError } from '@/lib/api-error';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import type { ReversalResultDto } from '@/lib/loyalty-purchases';

export interface ReversalFormState {
  /** A stable code the screen translates; never raw server text. */
  errorCode?: 'NO_BUSINESS' | 'REASON_REQUIRED' | 'CONFIRM_REQUIRED' | 'ALREADY_REVERSED' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'CANNOT_REPRODUCE' | 'FAILED';
  result?: ReversalResultDto;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reverses one purchase. The reason (3 to 200 characters) and an explicit confirmation are required here AND by the API, which alone decides
 * authorization (loyalty:adjust, business-wide): this action never grants anything, and a cashier is refused at the API.
 */
export async function reversePurchaseAction(_prev: ReversalFormState, formData: FormData): Promise<ReversalFormState> {
  const business = await getActiveBusiness();
  if (!business) return { errorCode: 'NO_BUSINESS' };
  const purchaseId = String(formData.get('purchaseId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!UUID.test(purchaseId)) return { errorCode: 'NOT_FOUND' };
  if (reason.length < 3 || reason.length > 200) return { errorCode: 'REASON_REQUIRED' };
  if (formData.get('confirm') !== 'yes') return { errorCode: 'CONFIRM_REQUIRED' };
  try {
    const result = await apiFetch<ReversalResultDto>(`/loyalty/purchases/${purchaseId}/reverse`, {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({ reason }),
    });
    revalidatePath('/dashboard/loyalty/purchases');
    revalidatePath(`/dashboard/loyalty/purchases/${purchaseId}`);
    return { result };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'PURCHASE_ALREADY_REVERSED') return { errorCode: 'ALREADY_REVERSED' };
      if (error.code === 'PURCHASE_NOT_FOUND' || error.status === 404) return { errorCode: 'NOT_FOUND' };
      if (error.code === 'PROGRESS_REPLAY_MISMATCH') return { errorCode: 'CANNOT_REPRODUCE' };
      if (error.status === 403) return { errorCode: 'NOT_ALLOWED' };
    }
    return { errorCode: 'FAILED' };
  }
}
