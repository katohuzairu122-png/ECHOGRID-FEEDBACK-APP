'use server';

import type {
  LoyaltyResolvedActionDto,
  LoyaltyTransactionDto,
  LookupCustomerResultDto,
} from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { redemptionCodeSegment } from '@/lib/redemption-code';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { classifyQrFailure, type StaffQrErrorKind } from '@/lib/qr-failure';
import { classifyCashierInput } from '@/lib/cashier-identifier';

export type { StaffQrErrorKind };

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
  /** Machine-readable outcome so the UI can show a precise, localized message; never carries token data. */
  errorKind?: StaffQrErrorKind;
  result?: StaffQrResult;
  /** Customer identified by phone lookup (D-C2). The lookup token is the only handle: no ids are ever shown. */
  lookup?: LookupCustomerResultDto;
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
    throw new ApiError(
      'Business context changed. Resolve the QR again.',
      403,
      'BUSINESS_CONTEXT_CHANGED',
    );
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
    errorKind: classifyQrFailure(err),
  };
}

async function businessScope(branchId: string, expectedBusinessId?: string) {
  const business = await getActiveBusiness();
  if (!business || (expectedBusinessId && business.id !== expectedBusinessId)) {
    throw new ApiError(
      'Business context changed. Look the customer up again.',
      403,
      'BUSINESS_CONTEXT_CHANGED',
    );
  }
  return {
    businessId: business.id,
    ...(branchId ? { branchId } : {}),
    cache: 'no-store' as const,
  };
}

export async function resolveStaffQrAction(
  _prev: StaffQrState,
  form: FormData,
): Promise<StaffQrState> {
  try {
    // One field for a scanner, paste or typing. Only a signed QR token or a phone number with its country code
    // is accepted; nothing else is guessed (see classifyCashierInput).
    const input = classifyCashierInput(String(form.get('token') ?? ''));
    if (input.kind === 'invalid') {
      return {
        error:
          input.reason === 'countryCode'
            ? 'Enter the phone number with the country code, for example +15551234567.'
            : 'Scan a QR code or enter a phone number.',
        errorKind: input.reason === 'countryCode' ? 'phoneCountryCode' : 'unrecognizedInput',
      };
    }
    const branchId = String(form.get('branchId') ?? '').trim();

    if (input.kind === 'phone') {
      const scope = await businessScope(branchId);
      const lookup = await apiFetch<LookupCustomerResultDto>('/loyalty/actions/lookup-customer', {
        ...scope,
        method: 'POST',
        body: JSON.stringify({ phone: input.value }),
      });
      return {
        lookup,
        businessId: scope.businessId,
        branchId: scope.branchId,
        purchaseRequestKey: crypto.randomUUID(),
      };
    }

    const token = input.value;
    const { result, scope } = await resolve(token, branchId);
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

/**
 * Records a purchase for a customer identified by phone lookup. The lookup token is the only handle: it is
 * re-verified server-side (binding, expiry, membership, daily caps) and the loyalty account id is never sent to
 * or from the browser. Reward redemption is not offered on this path (it needs the customer's own code).
 */
export async function staffLookupPurchaseAction(
  _prev: StaffQrState,
  form: FormData,
): Promise<StaffQrState> {
  const lookupToken = String(form.get('lookupToken') ?? '');
  const businessId = String(form.get('businessId') ?? '');
  const branchId = String(form.get('branchId') ?? '').trim();
  const idempotencyKey = String(form.get('idempotencyKey') ?? _prev.purchaseRequestKey ?? '');
  const kept: StaffQrState = {
    ...(_prev.lookup ? { lookup: _prev.lookup } : {}),
    businessId,
    branchId: branchId || undefined,
    purchaseRequestKey: idempotencyKey,
    purchaseCompleted: Boolean(_prev.purchaseCompleted),
  };
  try {
    const scope = await businessScope(branchId, businessId);
    await apiFetch('/loyalty/actions/lookup-purchase', {
      ...scope,
      method: 'POST',
      body: JSON.stringify({
        lookupToken,
        purchaseAmount: Number(form.get('purchaseAmount')),
        idempotencyKey,
      }),
    });
    return { ...kept, success: true, purchaseCompleted: true };
  } catch (err) {
    return { ...kept, ...failure(err) };
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
    const code = redemptionCodeSegment(String(form.get('code') ?? ''));
    if (code === null) throw new ApiError('Enter the redemption code exactly as shown.', 422);
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
  if (form.get('operation') === 'lookup-purchase') return staffLookupPurchaseAction(prev, form);
  return staffQrTransactionAction(
    String(form.get('token') ?? ''),
    String(form.get('branchId') ?? ''),
    String(form.get('businessId') ?? ''),
    prev,
    form,
  );
}
