'use server';

import type {
  LoyaltyResolvedActionDto,
  LoyaltyTransactionDto,
} from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export interface StaffQrResult {
  customerId: string;
  loyaltyAccountId: string | null;
  membershipStatus: 'active' | 'none';
  actions: LoyaltyResolvedActionDto[];
}
export interface StaffQrState {
  token?: string;
  purchaseRequestKey?: string;
  purchaseCompleted?: boolean;
  error?: string;
  result?: StaffQrResult;
  businessId?: string;
  branchId?: string | undefined;
  transaction?: LoyaltyTransactionDto;
  success?: boolean;
}

// Scope selectors are untrusted input. Tenant middleware validates both the
// active business grant and any branch grant on every API request.
async function resolve(token: string, branchId: string, expectedBusinessId?: string) {
  const business = await getActiveBusiness();
  if (!business || (expectedBusinessId && business.id !== expectedBusinessId)) {
    throw new ApiError('Business context changed. Resolve the QR again.', 403);
  }
  const scope = {
    businessId: business.id,
    ...(branchId ? { branchId } : {}),
    cache: 'no-store' as const,
  };
  const result = await apiFetch<StaffQrResult>('/loyalty/actions/resolve-customer', {
    ...scope,
    method: 'POST',
    body: JSON.stringify({ customerQrToken: token }),
  });
  return { result, scope };
}

function failure(err: unknown): StaffQrState {
  rethrowControlFlow(err);
  return {
    error: err instanceof ApiError ? err.message : 'Unable to complete this action. Try again.',
  };
}

export async function resolveStaffQrAction(
  _prev: StaffQrState,
  form: FormData,
): Promise<StaffQrState> {
  try {
    const token = String(form.get('token') ?? '');
    const { result, scope } = await resolve(token, String(form.get('branchId') ?? '').trim());
    return {
      result,
      token,
      businessId: scope.businessId,
      branchId: scope.branchId,
      purchaseRequestKey:
        !_prev.purchaseCompleted &&
        _prev.token === token &&
        _prev.businessId === scope.businessId &&
        _prev.branchId === scope.branchId
          ? (_prev.purchaseRequestKey ?? crypto.randomUUID())
          : crypto.randomUUID(),
    };
  } catch (err) {
    return failure(err);
  }
}

export async function staffQrTransactionAction(
  token: string,
  branchId: string,
  businessId: string,
  _prev: StaffQrState,
  form: FormData,
): Promise<StaffQrState> {
  let verifiedState: StaffQrState = {};
  try {
    const { result, scope } = await resolve(token, branchId, businessId);
    verifiedState = {
      purchaseCompleted: Boolean(_prev.purchaseCompleted),
      result,
      token,
      businessId: scope.businessId,
      branchId: scope.branchId,
      purchaseRequestKey: String(form.get('idempotencyKey') ?? _prev.purchaseRequestKey ?? ''),
    };
    const operation = String(form.get('operation') ?? '');
    if (!result.loyaltyAccountId) throw new ApiError('No eligible loyalty membership.', 403);
    if (operation === 'purchase') {
      if (
        !result.actions.includes('VALIDATE_PURCHASE') ||
        !result.actions.includes('GRANT_LOYALTY_PROGRESS')
      ) {
        throw new ApiError('Purchase validation is not permitted.', 403);
      }
      await apiFetch(`/loyalty/accounts/${result.loyaltyAccountId}/purchase`, {
        ...scope,
        method: 'POST',
        body: JSON.stringify({
          purchaseAmount: Number(form.get('purchaseAmount')),
          idempotencyKey: String(form.get('idempotencyKey') ?? ''),
          channel: 'other',
        }),
      });
      return { ...verifiedState, success: true, purchaseCompleted: true };
    }
    if (!result.actions.includes('REDEEM_REWARD') || !['lookup', 'confirm'].includes(operation)) {
      throw new ApiError('Reward redemption is not permitted.', 403);
    }
    const code = encodeURIComponent(
      String(form.get('code') ?? '')
        .trim()
        .toUpperCase(),
    );
    const transaction = await apiFetch<LoyaltyTransactionDto>(
      `/loyalty/redemptions/${code}`,
      scope,
    );
    // The existing endpoint scopes to this business; additionally bind this
    // handoff to the freshly verified scanned customer's account.
    if (transaction.loyaltyAccountId !== result.loyaltyAccountId) {
      throw new ApiError('This reward does not belong to the scanned membership.', 403);
    }
    if (operation === 'lookup') return { ...verifiedState, transaction };
    if (
      String(form.get('reviewedCode') ?? '')
        .trim()
        .toUpperCase() !== transaction.redemptionCode
    ) {
      throw new ApiError('Review this reward code before confirming the handoff.', 409);
    }
    await apiFetch(`/loyalty/redemptions/${code}/confirm`, { ...scope, method: 'POST' });
    return { ...verifiedState, success: true };
  } catch (err) {
    return { ...verifiedState, ...failure(err) };
  }
}

// A single state owner also preserves the resolved menu across native form
// submissions before hydration. Previous state never grants authorization.
export async function staffUnifiedQrAction(
  prev: StaffQrState,
  form: FormData,
): Promise<StaffQrState> {
  if (form.get('operation') === 'resolve') return resolveStaffQrAction(prev, form);
  return staffQrTransactionAction(
    String(form.get('token') ?? ''),
    String(form.get('branchId') ?? ''),
    String(form.get('businessId') ?? ''),
    prev,
    form,
  );
}
