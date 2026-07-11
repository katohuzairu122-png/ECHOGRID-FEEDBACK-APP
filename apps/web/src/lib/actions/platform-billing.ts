'use server';

import { revalidatePath } from 'next/cache';
import type { CreateSubscriptionPlanInput, UpdateSubscriptionPlanInput } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';

export interface PlatformBillingActionState {
  error?: string;
  success?: boolean;
}

const PLANS_PATH = '/platform/billing/plans';

/** Dollars in the form (natural for an admin to type), cents on the wire --
 * same reasoning either way, so this one converter backs both create and
 * update instead of duplicating the parsing logic. Empty optional fields
 * (yearly price, branch/user limits, Stripe price IDs) become `undefined`,
 * not `0`/`''`, so a PATCH only carries the fields actually filled in. */
function readPlanForm(formData: FormData): CreateSubscriptionPlanInput {
  const priceMonthlyDollars = Number(formData.get('priceMonthlyDollars'));
  const priceYearlyDollarsRaw = String(formData.get('priceYearlyDollars') ?? '').trim();
  const maxBranchesRaw = String(formData.get('maxBranches') ?? '').trim();
  const maxUsersRaw = String(formData.get('maxUsers') ?? '').trim();
  const stripePriceIdMonthly = String(formData.get('stripePriceIdMonthly') ?? '').trim();
  const stripePriceIdYearly = String(formData.get('stripePriceIdYearly') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  return {
    key: String(formData.get('key') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim(),
    description: description || undefined,
    priceMonthlyCents: Math.round(priceMonthlyDollars * 100),
    priceYearlyCents: priceYearlyDollarsRaw ? Math.round(Number(priceYearlyDollarsRaw) * 100) : undefined,
    currency: String(formData.get('currency') ?? 'usd').trim() || 'usd',
    stripePriceIdMonthly: stripePriceIdMonthly || undefined,
    stripePriceIdYearly: stripePriceIdYearly || undefined,
    maxBranches: maxBranchesRaw ? Number(maxBranchesRaw) : undefined,
    maxUsers: maxUsersRaw ? Number(maxUsersRaw) : undefined,
    isActive: formData.get('isActive') === 'on',
    isDefaultTrial: formData.get('isDefaultTrial') === 'on',
    sortOrder: Number(formData.get('sortOrder') ?? 0),
  };
}

export async function createPlanAction(
  _prevState: PlatformBillingActionState,
  formData: FormData,
): Promise<PlatformBillingActionState> {
  try {
    await apiFetch(PLANS_PATH, {
      method: 'POST',
      body: JSON.stringify(readPlanForm(formData)),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(PLANS_PATH);
  return { success: true };
}

/** Bound with `.bind(null, planId)` at the call site (plan-form-dialog.tsx)
 * -- the standard pattern this codebase uses throughout for an extra
 * useActionState argument. key is intentionally excluded from the payload
 * (readPlanForm's `key` field is dropped here since updateSubscriptionPlanSchema
 * omits it server-side too -- it's immutable after creation). */
export async function updatePlanAction(
  planId: string,
  _prevState: PlatformBillingActionState,
  formData: FormData,
): Promise<PlatformBillingActionState> {
  const { key: _key, ...patch }: Partial<UpdateSubscriptionPlanInput> & { key?: string } =
    readPlanForm(formData);

  try {
    await apiFetch(`${PLANS_PATH}/${planId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(PLANS_PATH);
  return { success: true };
}
