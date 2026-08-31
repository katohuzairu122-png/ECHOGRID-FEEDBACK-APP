'use server';

import { revalidatePath } from 'next/cache';
import type {
  LoyaltyAccountWithCustomerDto,
  LoyaltyTierDto,
  LoyaltyRewardDto,
  LoyaltyTransactionDto,
} from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

export interface LoyaltyFormState {
  error?: string;
  success?: boolean;
}

const LOYALTY_PATH = '/dashboard/loyalty';

// ---- Points engine (Block 3) ---------------------------------------------

export async function recordPurchaseAction(
  accountId: string,
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  const purchaseAmount = Number(formData.get('purchaseAmount'));
  try {
    await apiFetch(`/loyalty/accounts/${accountId}/purchase`, {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({ purchaseAmount }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(LOYALTY_PATH);
  return { success: true };
}

export async function adjustPointsAction(
  accountId: string,
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  const points = Number(formData.get('points'));
  const notes = String(formData.get('notes') ?? '').trim() || undefined;
  try {
    await apiFetch(`/loyalty/accounts/${accountId}/adjust`, {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({ points, notes }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(LOYALTY_PATH);
  return { success: true };
}

// ---- Tiers (Block 4) -------------------------------------------------------

export async function createTierAction(
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch('/loyalty/tiers', {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({
        name: String(formData.get('name') ?? ''),
        minPoints: Number(formData.get('minPoints')),
        benefits: String(formData.get('benefits') ?? '').trim() || undefined,
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`${LOYALTY_PATH}/tiers`);
  return { success: true };
}

export async function updateTierAction(
  tierId: string,
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch(`/loyalty/tiers/${tierId}`, {
      method: 'PATCH',
      businessId: business.id,
      body: JSON.stringify({
        name: String(formData.get('name') ?? ''),
        minPoints: Number(formData.get('minPoints')),
        benefits: String(formData.get('benefits') ?? '').trim() || undefined,
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`${LOYALTY_PATH}/tiers`);
  return { success: true };
}

export async function deleteTierAction(tierId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  await apiFetch(`/loyalty/tiers/${tierId}`, { method: 'DELETE', businessId: business.id });
  revalidatePath(`${LOYALTY_PATH}/tiers`);
}

// ---- Rewards (Block 4) ------------------------------------------------------

/** Shared by createRewardAction/updateRewardAction so the FormData parsing
 * for Continuing Development Block 6.8.1's four new fields (type, branchId,
 * pointsCost, rewardValue) lives in exactly one place -- these two actions'
 * bodies were already near-duplicates before this block; doubling that
 * duplicated block's size instead of extracting would leave two copies of
 * the same conditional-field logic to keep in sync.
 *
 * pointsCost/rewardValue are included only when their FormData entry is
 * present AND non-blank -- an absent entry (the field wasn't rendered,
 * since RewardFormDialog shows only one of the two depending on `type`) or
 * a blank one becomes `undefined`, which JSON.stringify drops from the
 * request body entirely. That matches the API's own "omitted key = don't
 * touch / not provided" convention (see loyalty-reward.service.ts's
 * convertCampaignFields comment) rather than coercing a blank field to 0.
 *
 * branchId sends an explicit `null` for the empty "All branches" option,
 * not `undefined` -- the one field where an update needs to actively clear
 * an already-set value, not just leave it alone untouched (see
 * packages/shared-types/src/loyalty.ts's rewardCampaignFields.branchId
 * comment for the full reasoning this was widened to accept null). */
function buildRewardBody(formData: FormData) {
  const rawPointsCost = formData.get('pointsCost');
  const rawRewardValue = formData.get('rewardValue');
  return {
    name: String(formData.get('name') ?? ''),
    description: String(formData.get('description') ?? '').trim() || undefined,
    type: String(formData.get('type') ?? 'points'),
    branchId: String(formData.get('branchId') ?? '').trim() || null,
    pointsCost:
      rawPointsCost !== null && String(rawPointsCost).trim() !== '' ? Number(rawPointsCost) : undefined,
    rewardValue:
      rawRewardValue !== null && String(rawRewardValue).trim() !== '' ? Number(rawRewardValue) : undefined,
  };
}

export async function createRewardAction(
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch('/loyalty/rewards', {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify(buildRewardBody(formData)),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`${LOYALTY_PATH}/rewards`);
  return { success: true };
}

export async function updateRewardAction(
  rewardId: string,
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch(`/loyalty/rewards/${rewardId}`, {
      method: 'PATCH',
      businessId: business.id,
      body: JSON.stringify(buildRewardBody(formData)),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`${LOYALTY_PATH}/rewards`);
  return { success: true };
}

/** Toggle-only action for the active/inactive switch on each reward row --
 * a status flip needs no form, so it's imperative like deleteBranchAction. */
export async function toggleRewardStatusAction(
  rewardId: string,
  nextStatus: 'active' | 'inactive',
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  await apiFetch(`/loyalty/rewards/${rewardId}`, {
    method: 'PATCH',
    businessId: business.id,
    body: JSON.stringify({ status: nextStatus }),
  });
  revalidatePath(`${LOYALTY_PATH}/rewards`);
}

export async function deleteRewardAction(rewardId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  await apiFetch(`/loyalty/rewards/${rewardId}`, { method: 'DELETE', businessId: business.id });
  revalidatePath(`${LOYALTY_PATH}/rewards`);
}

// ---- Program settings (Block 3) --------------------------------------------

export async function updateSettingsAction(
  _prevState: LoyaltyFormState,
  formData: FormData,
): Promise<LoyaltyFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch('/loyalty/settings', {
      method: 'PATCH',
      businessId: business.id,
      body: JSON.stringify({
        pointsPerCheckin: Number(formData.get('pointsPerCheckin')),
        pointsPerCurrencyUnit: Number(formData.get('pointsPerCurrencyUnit')),
        referralBonusPoints: Number(formData.get('referralBonusPoints')),
        birthdayBonusPoints: Number(formData.get('birthdayBonusPoints')),
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`${LOYALTY_PATH}/settings`);
  return { success: true };
}

// ---- Redemption confirmation (Block 4) -------------------------------------

export interface RedemptionLookupState {
  error?: string;
  transaction?: LoyaltyTransactionDto;
}

export async function lookupRedemptionAction(
  _prevState: RedemptionLookupState,
  formData: FormData,
): Promise<RedemptionLookupState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  try {
    const transaction = await apiFetch<LoyaltyTransactionDto>(`/loyalty/redemptions/${code}`, {
      businessId: business.id,
    });
    return { transaction };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }
}

export async function confirmRedemptionAction(code: string): Promise<LoyaltyTransactionDto> {
  const business = await getActiveBusiness();
  if (!business) throw new Error('No active business.');

  return apiFetch<LoyaltyTransactionDto>(`/loyalty/redemptions/${code}/confirm`, {
    method: 'POST',
    businessId: business.id,
  });
}
