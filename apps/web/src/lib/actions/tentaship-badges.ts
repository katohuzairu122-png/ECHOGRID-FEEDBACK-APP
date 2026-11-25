'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api-client';
import { customerApiFetch } from '@/lib/customer-api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export type EvaluateBadgesState = { status?: 'done' | 'failed'; awarded?: number };

/** Asks the SERVER to evaluate the signed-in customer's own verified evidence. The request carries no input: nothing here can influence an award. */
export async function evaluateMyBadgesAction(_prev: EvaluateBadgesState): Promise<EvaluateBadgesState> {
  try {
    const res = await customerApiFetch<{ awarded: unknown[] }>('/tentaship-badges/me/evaluate', { method: 'POST', cache: 'no-store' });
    revalidatePath('/loyalty/dashboard/community');
    return { status: 'done', awarded: Array.isArray(res.awarded) ? res.awarded.length : 0 };
  } catch (error) {
    rethrowControlFlow(error);
    return { status: 'failed' };
  }
}

export async function evaluateBusinessBadgesAction(_prev: EvaluateBadgesState): Promise<EvaluateBadgesState> {
  try {
    const business = await getActiveBusiness();
    if (!business) return { status: 'failed' };
    const res = await apiFetch<{ awarded: unknown[] }>('/tentaship-badges/business/evaluate', { method: 'POST', businessId: business.id, cache: 'no-store' });
    revalidatePath('/dashboard/community');
    return { status: 'done', awarded: Array.isArray(res.awarded) ? res.awarded.length : 0 };
  } catch (error) {
    rethrowControlFlow(error);
    return { status: 'failed' };
  }
}
