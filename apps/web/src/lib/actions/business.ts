'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { BusinessDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

export interface CreateBusinessState {
  error?: string;
}

interface CreateBusinessResult {
  businessId: string;
  ownerRoleId: string;
}

export async function createBusinessAction(
  _prevState: CreateBusinessState,
  formData: FormData,
): Promise<CreateBusinessState> {
  const name = String(formData.get('name') ?? '');
  const slug = String(formData.get('slug') ?? '');

  try {
    await apiFetch<CreateBusinessResult>('/businesses', {
      method: 'POST',
      body: JSON.stringify({ name, slug }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  redirect('/dashboard');
}

// ---- Settings (i18n & Multi-Currency Block 3) ------------------------------

export interface BusinessSettingsFormState {
  error?: string;
  success?: boolean;
}

const SETTINGS_PATH = '/dashboard/settings';

/**
 * The only mutation path for a business's name/defaultLocale/
 * defaultCurrency/defaultTimezone -- backs the settings form added in
 * Block 3. 403s surface via the same state.error + form-error UI every
 * other gated form in this app uses (business:manage_settings is not
 * checked client-side, matching this codebase's one deliberate,
 * consistent permission-UX convention -- see notification-log.tsx's
 * comment for the same rationale applied elsewhere).
 */
export async function updateBusinessSettingsAction(
  _prevState: BusinessSettingsFormState,
  formData: FormData,
): Promise<BusinessSettingsFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch<BusinessDto>('/businesses/me', {
      method: 'PATCH',
      businessId: business.id,
      body: JSON.stringify({
        name: String(formData.get('name') ?? ''),
        defaultLocale: String(formData.get('defaultLocale') ?? ''),
        defaultCurrency: String(formData.get('defaultCurrency') ?? ''),
        defaultTimezone: String(formData.get('defaultTimezone') ?? ''),
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(SETTINGS_PATH);
  return { success: true };
}
