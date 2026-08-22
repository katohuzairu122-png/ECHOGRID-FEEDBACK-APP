'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { getCurrentUser } from '@/lib/platform';

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

/** "Assign to me" is the only assignment UI this slice ships (no picker for
 * assigning to a *different* teammate yet) -- covers the common case of a
 * manager claiming a row to work on personally. */
export async function assignToMeAction(feedbackId: string): Promise<void> {
  const [business, user] = await Promise.all([getActiveBusiness(), getCurrentUser()]);
  if (!business || !user) return;

  await apiFetch(`/feedback/${feedbackId}/assign`, {
    method: 'POST',
    businessId: business.id,
    body: JSON.stringify({ assignedTo: user.id }),
  });

  revalidatePath('/dashboard/feedback');
}

export async function bulkAssignToMeAction(feedbackIds: string[]): Promise<void> {
  const [business, user] = await Promise.all([getActiveBusiness(), getCurrentUser()]);
  if (!business || !user || feedbackIds.length === 0) return;

  await apiFetch('/feedback/bulk/assign', {
    method: 'POST',
    businessId: business.id,
    body: JSON.stringify({ feedbackIds, assignedTo: user.id }),
  });

  revalidatePath('/dashboard/feedback');
}

export async function bulkMarkReviewedAction(feedbackIds: string[]): Promise<void> {
  const business = await getActiveBusiness();
  if (!business || feedbackIds.length === 0) return;

  await apiFetch('/feedback/bulk/status', {
    method: 'POST',
    businessId: business.id,
    body: JSON.stringify({ feedbackIds, status: 'reviewed' }),
  });

  revalidatePath('/dashboard/feedback');
}
