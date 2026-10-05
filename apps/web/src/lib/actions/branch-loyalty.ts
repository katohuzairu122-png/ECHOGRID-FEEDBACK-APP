'use server';
import { revalidatePath } from 'next/cache';
import { customerApiFetch } from '@/lib/customer-api-client';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
export interface BranchActionState {
  error?: string;
  message?: string;
  code?: string;
  membershipId?: string;
}
export async function branchCustomerAction(
  operation: 'join' | 'redeem' | 'community',
  id: string,
  _state: BranchActionState,
  data: FormData,
): Promise<BranchActionState> {
  try {
    if (operation === 'join') {
      const membership = await customerApiFetch<{ id: string }>(
        '/branch-loyalty/me/join',
        {
          method: 'POST',
          body: JSON.stringify({ qrToken: id, joinCommunity: data.get('joinCommunity') === 'on' }),
        },
        `/loyalty/${id}`,
      );
      revalidatePath(`/loyalty/${id}`);
      revalidatePath(`/feedback/${id}`);
      return {
        membershipId: membership.id,
        message:
          'Enrollment started. Show your membership QR to staff when making a qualifying purchase.',
      };
    }
    if (operation === 'community') {
      await customerApiFetch('/branch-loyalty/me/community', {
        method: 'POST',
        body: JSON.stringify({ joined: data.get('joined') === 'on' }),
      });
      revalidatePath('/loyalty/dashboard/branches');
      return { message: 'Community preference saved.' };
    }
    const result = await customerApiFetch<{ code: string }>(
      `/branch-loyalty/me/memberships/${id}/redeem`,
      { method: 'POST', body: JSON.stringify({ requestId: data.get('requestId') }) },
    );
    revalidatePath('/loyalty/dashboard/branches');
    return {
      code: result.code,
      message: 'Show this code to staff at this branch to receive your reward.',
    };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    throw err;
  }
}
export async function branchStaffAction(
  operation: 'program' | 'purchase' | 'refund' | 'confirm',
  branchId: string,
  _state: BranchActionState,
  data: FormData,
): Promise<BranchActionState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'Select a business first.' };
  const body =
    operation === 'program'
      ? {
          onboardingMode: data.get('onboardingMode'),
          listedInCommunity: data.get('listedInCommunity') === 'on',
          qualifyingPurchaseDescription: data.get('qualifyingPurchaseDescription'),
          unitLabel: data.get('unitLabel'),
          rewardName: data.get('rewardName'),
          rewardCost: Number(data.get('rewardCost')),
          enabled: data.get('enabled') === 'on',
          feedbackBonusUnits: Number(data.get('feedbackBonusUnits')),
        }
      : operation === 'purchase'
        ? {
            membershipId: data.get('membershipId'),
            receiptReference: data.get('receiptReference'),
            qualifyingUnits: Number(data.get('qualifyingUnits')),
            evidence: data.get('evidence'),
          }
        : operation === 'refund'
          ? { purchaseId: data.get('purchaseId'), reason: data.get('reason') }
          : { code: data.get('code') };
  const path =
    operation === 'program'
      ? 'program'
      : operation === 'purchase'
        ? 'purchases'
        : operation === 'refund'
          ? 'refunds'
          : 'confirm';
  try {
    const result = await apiFetch<{ id?: string }>(
      `/branch-loyalty/staff/branches/${branchId}/${path}`,
      {
        method: operation === 'program' ? 'PUT' : 'POST',
        businessId: business.id,
        branchId,
        body: JSON.stringify(body),
      },
    );
    revalidatePath('/dashboard/loyalty/branches');
    return { message: `Saved.${result.id ? ` Transaction: ${result.id}` : ''}` };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    throw err;
  }
}
