'use server';

import { revalidatePath } from 'next/cache';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-error';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export type FollowState = { ok?: true; following?: boolean; error?: 'unavailable' | 'limit' | 'gone' };
const HANDLE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Follow or unfollow ONE published business. Only an opaque profile handle and the intended direction are accepted; the customer comes from the
 * session. A follow never enrolls the customer anywhere, grants consent or starts any message. The API owns every rule.
 */
export async function setFollowAction(_previous: FollowState, form: FormData): Promise<FollowState> {
  const handle = String(form.get('handle') ?? '');
  const follow = form.get('follow') === 'yes';
  if (!HANDLE.test(handle) || [...form.keys()].some((k) => k !== 'handle' && k !== 'follow' && !k.startsWith('$ACTION_'))) return { error: 'unavailable' };
  try {
    await customerApiFetch(`/network/follows/${handle}`, { method: follow ? 'PUT' : 'DELETE' }, '/loyalty/dashboard/community/feed');
    revalidatePath('/loyalty/dashboard/community/feed');
    return { ok: true, following: follow };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError) {
      if (error.code === 'NETWORK_FOLLOW_LIMIT') return { error: 'limit' };
      if (error.status === 404) return { error: 'gone' };
    }
    return { error: 'unavailable' };
  }
}

/**
 * BCOMM-05: record that the signed-in customer opened a BUSINESS post's link. Fire-and-forget evidence for the business's thresholded insights:
 * only a handle is accepted, the customer comes from the session, a failure is silent (it must never block opening the link), and the API
 * counts at most once per customer, post and day. This is never a consent, enrollment or marketing signal.
 */
export async function recordLinkOpenAction(handle: string): Promise<void> {
  if (!HANDLE.test(handle)) return;
  try {
    await customerApiFetch(`/network/engagement/${handle}`, { method: 'POST' }, '/loyalty/dashboard/community/feed');
  } catch (error) {
    rethrowControlFlow(error);
  }
}
