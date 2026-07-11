'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

/** Mirrors deleteBranchAction's shape exactly -- silent no-op with no
 * active business, revalidatePath after a successful mutation since this
 * list page (unlike Blocks 3/4's actions) IS a cached view of this data. */
export async function markReviewedAction(feedbackId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  await apiFetch(`/feedback/${feedbackId}`, {
    method: 'PATCH',
    businessId: business.id,
    body: JSON.stringify({ status: 'reviewed' }),
  });

  revalidatePath('/dashboard/feedback');
}

export async function deleteFeedbackAction(feedbackId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  await apiFetch(`/feedback/${feedbackId}`, {
    method: 'DELETE',
    businessId: business.id,
  });

  revalidatePath('/dashboard/feedback');
}
