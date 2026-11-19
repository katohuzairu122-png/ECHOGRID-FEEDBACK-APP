'use server';

import { revalidatePath } from 'next/cache';
import { CURRENT_JOIN_LOYALTY_CONSENT_VERSION } from '@echo-grid-feedback/shared-types';
import type {
  CustomerMembershipDto,
  JoinCustomerMembershipResultDto,
  LoyaltyAccountDto,
  RedemptionResult,
  MaterializedNotificationPreferenceDto,
  NotificationEventType,
  NotificationChannel,
} from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { ApiError } from '@/lib/api-client';

export interface CustomerQrCredential {
  token: string;
  expiresAt: string;
}

/** Renews the customer's identity QR (valid up to 24h). Identity only: it authorizes no points, redemption or payment. */
export async function refreshCustomerQrAction(): Promise<CustomerQrCredential> {
  return customerApiFetch<CustomerQrCredential>('/loyalty/me/customer-qr', { cache: 'no-store' });
}

/** Revokes every customer QR issued so far (lost phone / shared screenshot) and returns a fresh one. */
export async function revokeCustomerQrAction(): Promise<CustomerQrCredential> {
  return customerApiFetch<CustomerQrCredential>('/loyalty/me/customer-qr/revoke', { method: 'POST', cache: 'no-store' });
}

/** Explicit customer-consented join through a server-verified business QR
 * context. Split 01 deliberately rejects arbitrary businessId-only enrollment,
 * and a join the customer did not explicitly accept: `consentAccepted` must be
 * the literal `true`. A Server Action can be invoked with any arguments, so it
 * refuses here without a round trip; the API enforces the same rule. */
export async function joinLoyaltyAction(qrToken: string, consentAccepted: boolean): Promise<LoyaltyAccountDto> {
  if (consentAccepted !== true) {
    throw new ApiError('Accept the loyalty program consent to join.', 400, 'CONSENT_REQUIRED');
  }
  const result = await customerApiFetch<JoinCustomerMembershipResultDto>('/customer-memberships/join', {
    method: 'POST',
    body: JSON.stringify({ qrToken, consentAccepted: true, consentVersion: CURRENT_JOIN_LOYALTY_CONSENT_VERSION }),
  });
  revalidatePath('/loyalty/dashboard');
  return result.loyaltyAccount;
}

/**
 * CASHIER-AUTH-02D: the customer accepts a cashier-issued one-time invitation, signed in as themselves and with explicit consent. The
 * invitation (not this request) decides the business and branch; nothing the browser sends can choose them. Failures become serialisable
 * state so the screen can say what to do (ask the cashier for a new one, verify a phone) instead of a generic server-action error.
 */
export interface JoinAssistedResult {
  error?: string;
  code?: string;
  account?: LoyaltyAccountDto;
}

export async function joinAssistedAction(inviteToken: string, consentAccepted: boolean): Promise<JoinAssistedResult> {
  if (consentAccepted !== true) return { error: 'Accept the loyalty program consent to join.', code: 'CONSENT_REQUIRED' };
  if (typeof inviteToken !== 'string' || inviteToken.length === 0 || inviteToken.length > 2048) {
    return { error: 'This invitation is not valid.', code: 'ONBOARDING_INVITE_INVALID' };
  }
  try {
    const result = await customerApiFetch<JoinCustomerMembershipResultDto>(
      '/customer-memberships/join-assisted',
      { method: 'POST', body: JSON.stringify({ inviteToken, consentAccepted: true, consentVersion: CURRENT_JOIN_LOYALTY_CONSENT_VERSION }) },
      `/loyalty/invite/${inviteToken}`,
    );
    revalidatePath('/loyalty/dashboard');
    return { account: result.loyaltyAccount };
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError) return { error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) };
    return { error: 'Something went wrong. Please try again.' };
  }
}

/** Scanning a branch's QR code while signed in as a customer -- reuses the
 * same token feedback's public form uses (one QR code, two possible
 * destinations depending on which link the customer taps). */
export interface CheckinResult {
  error?: string;
  code?: string;
  membershipRequired?: boolean;
  account?: LoyaltyAccountDto;
}

export async function checkinAction(qrToken: string): Promise<CheckinResult> {
  try {
    const account = await customerApiFetch<LoyaltyAccountDto>(
      '/loyalty/me/checkin',
      {
        method: 'POST',
        body: JSON.stringify({ qrToken }),
      },
      `/loyalty/${qrToken}?autocheckin=1`,
    );
    revalidatePath('/loyalty/dashboard');
    revalidatePath(`/loyalty/dashboard/${account.businessId}`);
    return { account };
  } catch (err) {
    // Preserve Next.js redirects raised by customerApiFetch for an expired
    // customer session. All ordinary API failures become serializable state
    // so the client can show the useful API message instead of Next.js's
    // production-only generic server-action error.
    rethrowControlFlow(err);
    if (err instanceof ApiError) {
      return {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        membershipRequired: err.code === 'MEMBERSHIP_REQUIRED',
      };
    }
    return { error: 'Something went wrong. Please try again.' };
  }
}

export async function joinAndCheckinAction(qrToken: string, consentAccepted: boolean): Promise<CheckinResult> {
  try {
    await joinLoyaltyAction(qrToken, consentAccepted);
    return await checkinAction(qrToken);
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError) {
      return {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
      };
    }
    return { error: 'Something went wrong. Please try again.' };
  }
}

export interface LeaveMembershipResult {
  error?: string;
  code?: string;
  /** True once the membership has ended (or already had). */
  left?: boolean;
}

/** The customer ends their own membership with a business. Earning and redeeming stop, the consent
 * they gave to join is withdrawn, and the points balance is kept for a later re-join. Failures become
 * serializable state, like checkinAction, so the dashboard can show a message instead of Next.js's
 * generic production server-action error; a session redirect is still re-thrown. */
export async function leaveLoyaltyAction(businessId: string): Promise<LeaveMembershipResult> {
  try {
    await customerApiFetch<CustomerMembershipDto>(`/customer-memberships/${businessId}/leave`, {
      method: 'POST',
    });
    revalidatePath('/loyalty/dashboard');
    revalidatePath(`/loyalty/dashboard/${businessId}`);
    return { left: true };
  } catch (err) {
    rethrowControlFlow(err);
    if (err instanceof ApiError) {
      return {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
      };
    }
    return { error: 'Something went wrong. Please try again.' };
  }
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
    // First, always: customerApiFetch redirects to /loyalty/login on a 401,
    // and redirect() signals that by throwing. Without this line the
    // sentinel falls through to the generic branch below, the navigation is
    // cancelled, and the customer sees "Something went wrong" instead of a
    // sign-in page. See lib/rethrow-control-flow.ts.
    rethrowControlFlow(err);
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
