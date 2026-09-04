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
/** Continuing Development Block 6.8.2 -- <input type="date"> only ever
 * yields a plain YYYY-MM-DD value, but createRewardSchema/updateRewardSchema
 * require a full ISO 8601 datetime (z.iso.datetime()). Converted here, not
 * in the dialog, so RewardFormDialog stays a plain uncontrolled date field
 * with no knowledge of the wire format.
 *
 * startDate becomes the very start of that UTC day; expiryDate the very
 * end of it (23:59:59.999) -- checked against
 * loyalty-redemption.service.ts's actual enforcement
 * (`now > reward.expiryDate` blocks redemption) before picking this, not
 * guessed: a business owner who picks Sept 30 as an end date means "valid
 * through Sept 30," not "expires at the first instant of Sept 30" -- the
 * same instant for both fields would make the expiry date exclusive
 * instead of inclusive.
 *
 * Both instants are UTC, not the business's own local timezone -- this
 * codebase has no per-business timezone setting anywhere yet (confirmed,
 * not assumed, by search before choosing this), and the schema itself
 * already requires a Z-suffixed UTC instant (z.iso.datetime() with no
 * {offset:true}), so a UTC calendar day is the only interpretation
 * consistent with what's already there, not a new limitation introduced
 * by this block. Worth knowing: a business near the UTC date line could
 * see a campaign start/end up to a day off from their own wall clock. */
function toStartOfDayUtc(dateOnly: string): string {
  return `${dateOnly}T00:00:00.000Z`;
}
function toEndOfDayUtc(dateOnly: string): string {
  return `${dateOnly}T23:59:59.999Z`;
}

/** Continuing Development Block 6.8.3 -- blank/absent becomes `null`
 * (actively clear), not `undefined` (leave alone). maxRewardsPerDay/
 * maxBudget/limitPer/limitPeriodDays/cooldownSeconds were all widened to
 * nullable in this block (see rewardCampaignFields' own comment in
 * packages/shared-types/src/loyalty.ts for why): each is a standalone
 * limit a manager sets and later removes, so an emptied field should mean
 * "no limit," the same way emptying branchId's <select> back to "All
 * branches" means "clear the scope" (Block 6.8.1) -- not pointsCost/
 * rewardValue's blank-means-leave-it-alone precedent above, which exists
 * for a different reason (those two go inert, not stale-and-wrong, when
 * `type` changes). */
function toNullableNumber(raw: FormDataEntryValue | null): number | null {
  return raw !== null && String(raw).trim() !== '' ? Number(raw) : null;
}

function buildRewardBody(formData: FormData) {
  const rawPointsCost = formData.get('pointsCost');
  const rawRewardValue = formData.get('rewardValue');
  const rawStartDate = formData.get('startDate');
  const rawExpiryDate = formData.get('expiryDate');
  const rawStatus = formData.get('status');
  const rawLimitPer = formData.get('limitPer');
  const limitPer = rawLimitPer !== null && String(rawLimitPer).trim() !== '' ? String(rawLimitPer) : null;
  return {
    name: String(formData.get('name') ?? ''),
    description: String(formData.get('description') ?? '').trim() || undefined,
    type: String(formData.get('type') ?? 'points'),
    branchId: String(formData.get('branchId') ?? '').trim() || null,
    pointsCost:
      rawPointsCost !== null && String(rawPointsCost).trim() !== '' ? Number(rawPointsCost) : undefined,
    rewardValue:
      rawRewardValue !== null && String(rawRewardValue).trim() !== '' ? Number(rawRewardValue) : undefined,
    startDate:
      rawStartDate !== null && String(rawStartDate).trim() !== ''
        ? toStartOfDayUtc(String(rawStartDate))
        : undefined,
    expiryDate:
      rawExpiryDate !== null && String(rawExpiryDate).trim() !== ''
        ? toEndOfDayUtc(String(rawExpiryDate))
        : undefined,
    // Absent entirely on create (the field isn't rendered -- see
    // RewardFormDialog's own comment on why status is edit-only), so this
    // naturally omits itself from a create body without a separate check.
    status: rawStatus !== null && String(rawStatus).trim() !== '' ? String(rawStatus) : undefined,
    maxRewardsPerDay: toNullableNumber(formData.get('maxRewardsPerDay')),
    maxBudget: toNullableNumber(formData.get('maxBudget')),
    limitPer,
    // Forced to null (not read from the form) whenever limitPer isn't
    // 'period', even though RewardFormDialog already unmounts this field
    // in that case -- belt-and-suspenders against sending a stale value
    // some other way, and it's what keeps limitPer/limitPeriodDays
    // consistent in the same request: updateRewardSchema's refine only
    // catches a 'period' selection missing limitPeriodDays, not a
    // NON-'period' selection leaving a previously-set limitPeriodDays
    // stranded in the DB (a real state the DB's own
    // loyalty_rewards_limit_period_days_required_check would then reject) --
    // this is what closes that gap, not the schema.
    limitPeriodDays: limitPer === 'period' ? toNullableNumber(formData.get('limitPeriodDays')) : null,
    cooldownSeconds: toNullableNumber(formData.get('cooldownSeconds')),
    // Continuing Development Block 4 of the S6.4 roadmap -- minCommentLength
    // reuses toNullableNumber, same clear-to-null convention as
    // maxRewardsPerDay/cooldownSeconds above (both fields go through the
    // exact same nullable-int shape at every layer since Block 6.9).
    // requireVisitVerification reads a Switch's checkbox state the same way
    // platform-billing.ts's isActive/isDefaultTrial and notifications.ts's
    // emailEnabled/smsEnabled already do -- 'on' when checked, otherwise
    // absent from FormData entirely, so `=== 'on'` is both the established
    // convention and the only correct check (a raw truthy/Boolean() coercion
    // would treat the string 'off' as true, which native checkboxes never
    // actually send, but is worth avoiding on principle).
    minCommentLength: toNullableNumber(formData.get('minCommentLength')),
    requireVisitVerification: formData.get('requireVisitVerification') === 'on',
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
