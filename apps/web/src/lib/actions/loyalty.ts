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
      body: JSON.stringify({
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? '').trim() || undefined,
        pointsCost: Number(formData.get('pointsCost')),
      }),
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
      body: JSON.stringify({
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? '').trim() || undefined,
        pointsCost: Number(formData.get('pointsCost')),
      }),
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

// Re-exported so page.tsx files can type their server-fetched lists without
// a second import from shared-types.
export type { LoyaltyAccountWithCustomerDto, LoyaltyTierDto, LoyaltyRewardDto };
