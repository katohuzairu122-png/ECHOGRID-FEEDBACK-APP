'use server';

import { revalidatePath } from 'next/cache';
import { communityMembershipSchema, communityPointAccountSchema } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-error';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export type CommunityLeaveState = { left?: true; error?: 'confirmation' | 'suspended' | 'missing' | 'unavailable' };

/** No customer id, policy version or identity assertion is accepted. The API owns all state transitions. */
export async function leaveCommunityAction(_previous: CommunityLeaveState, form: FormData): Promise<CommunityLeaveState> {
  if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes' ||
    [...form.keys()].some((key) => key !== 'confirmed' && !key.startsWith('$ACTION_'))) {
    return { error: 'confirmation' };
  }
  try {
    const raw = await customerApiFetch<{ membership: unknown; account: unknown }>('/community/me/leave',
      { method: 'POST' }, '/loyalty/dashboard/community');
    const membership = communityMembershipSchema.parse(raw.membership);
    const account = raw.account === null ? null : communityPointAccountSchema.parse(raw.account);
    if (membership.status !== 'left' || (account && (account.status !== 'closed' || account.customerId !== membership.customerId))) {
      return { error: 'unavailable' };
    }
    revalidatePath('/loyalty/dashboard/community');
    return { left: true };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError && error.code === 'COMMUNITY_MEMBERSHIP_SUSPENDED') return { error: 'suspended' };
    if (error instanceof ApiError && error.code === 'COMMUNITY_MEMBERSHIP_NOT_FOUND') return { error: 'missing' };
    return { error: 'unavailable' };
  }
}
