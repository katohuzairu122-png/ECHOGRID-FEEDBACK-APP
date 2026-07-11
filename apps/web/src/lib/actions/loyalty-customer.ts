'use server';

import { revalidatePath } from 'next/cache';
import type {
  LoyaltyAccountDto,
  RedemptionResult,
  MaterializedNotificationPreferenceDto,
  NotificationEventType,
  NotificationChannel,
} from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-client';

/** Explicit "join this business's loyalty program" action -- distinct from
 * checkinAction's auto-enroll, for a customer who wants to join without
 * having scanned a QR code yet (e.g. from a shared referral link, Block 5's
 * UI entry point for that flow). */
export async function joinLoyaltyAction(businessId: string): Promise<LoyaltyAccountDto> {
  const account = await customerApiFetch<LoyaltyAccountDto>('/loyalty/me/join', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
  });
  revalidatePath('/loyalty/dashboard');
  return account;
}

/** Scanning a branch's QR code while signed in as a customer -- reuses the
 * same token feedback's public form uses (one QR code, two possible
 * destinations depending on which link the customer taps). */
export async function checkinAction(qrToken: string): Promise<LoyaltyAccountDto> {
  const account = await customerApiFetch<LoyaltyAccountDto>('/loyalty/me/checkin', {
    method: 'POST',
    body: JSON.stringify({ qrToken }),
  });
  revalidatePath('/loyalty/dashboard');
  revalidatePath(`/loyalty/dashboard/${account.businessId}`);
  return account;
}

export interface RedeemState {
  error?: string;
  result?: RedemptionResult;
}

export async function redeemRewardAction(
  businessId: string,
  _prevState: RedeemState,
  formData: FormData,
): Promise<RedeemState> {
  const rewardId = String(formData.get('rewardId') ?? '');

  try {
    const result = await customerApiFetch<RedemptionResult>(
      `/loyalty/me/accounts/${businessId}/redeem`,
      { method: 'POST', body: JSON.stringify({ rewardId }) },
    );
    revalidatePath(`/loyalty/dashboard/${businessId}`);
    return { result };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }
}

// ---- Notification preferences (Notifications Block 5) ---------------------

/**
 * Called imperatively with an already-built array, not via useActionState +
 * FormData -- same "nested array doesn't fit a raw FormData parse" reasoning
 * as the staff equivalent (lib/actions/notifications.ts). `businessId` is an
 * explicit argument here (a route param on this customer surface) rather
 * than resolved from an active-business session the way the staff action
 * resolves it, matching how every other customer loyalty action in this
 * file (redeemRewardAction, checkinAction) already takes businessId
 * explicitly instead of assuming one.
 */
export async function updateNotificationPreferencesAction(
  businessId: string,
  preferences: Array<{ eventType: NotificationEventType; channel: NotificationChannel; enabled: boolean }>,
): Promise<MaterializedNotificationPreferenceDto[]> {
  const result = await customerApiFetch<MaterializedNotificationPreferenceDto[]>(
    `/loyalty/me/notification-preferences/${businessId}`,
    { method: 'PATCH', body: JSON.stringify({ preferences }) },
  );
  revalidatePath(`/loyalty/dashboard/${businessId}/notifications`);
  return result;
}
