'use server';

import { revalidatePath } from 'next/cache';
import { communityMembershipSchema, communityPointAccountSchema, joinCommunitySchema } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-error';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export type CommunityLeaveState = { left?: true; error?: 'confirmation' | 'suspended' | 'missing' | 'unavailable' };

export type CommunityJoinState = { joined?: true; released?: number; error?: 'acceptance' | 'stale' | 'phone' | 'suspended' | 'unavailable' };

/** Hidden fields are stale-view preconditions, never identity/terms authority. */
export async function joinCommunityAction(_previous: CommunityJoinState, form: FormData): Promise<CommunityJoinState> {
  const keys = ['operation','consentAccepted','expectedPublicationId','expectedTermsVersion','expectedTermsHash','expectedArtifactHash','displayedLocale','expectedTransitionId','idempotencyKey'];
  if ([...form.keys()].some((key) => !keys.includes(key) && !key.startsWith('$ACTION_')) || keys.some((key) => form.getAll(key).length !== 1) || form.get('consentAccepted') !== 'yes') return { error: 'acceptance' };
  const raw = Object.fromEntries(keys.map((key) => [key, form.get(key)]));
  const parsed = joinCommunitySchema.safeParse({ ...raw, consentAccepted: true, expectedTransitionId: raw.expectedTransitionId === '' ? null : raw.expectedTransitionId });
  if (!parsed.success) return { error: 'acceptance' };
  try {
    const response = await customerApiFetch<{ membership: unknown; account: unknown; consent?: { version?: unknown }; releasedPendingAwards?: unknown }>('/community/me/join', { method: 'POST', body: JSON.stringify(parsed.data) }, '/loyalty/dashboard/community');
    const membership = communityMembershipSchema.parse(response.membership); const account = communityPointAccountSchema.parse(response.account);
    if (membership.status !== 'active' || account.status !== 'active' || membership.customerId !== account.customerId || membership.policyVersion !== parsed.data.expectedTermsVersion || response.consent?.version !== parsed.data.expectedTermsVersion || !Number.isSafeInteger(response.releasedPendingAwards) || Number(response.releasedPendingAwards) < 0) return { error: 'unavailable' };
    revalidatePath('/loyalty/dashboard/community');
    return { joined: true, released: Number(response.releasedPendingAwards) };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError) {
      if (error.code === 'PHONE_VERIFICATION_REQUIRED') return { error: 'phone' };
      if (error.code === 'COMMUNITY_MEMBERSHIP_SUSPENDED' || error.code === 'CUSTOMER_NOT_AVAILABLE') return { error: 'suspended' };
      if (error.code === 'COMMUNITY_ACCEPTANCE_STALE' || error.code === 'COMMUNITY_TERMS_MISMATCH') return { error: 'stale' };
    }
    return { error: 'unavailable' };
  }
}

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
