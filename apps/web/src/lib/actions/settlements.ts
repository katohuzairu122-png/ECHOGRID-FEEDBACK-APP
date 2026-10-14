'use server';
import type {
  QrResolveDto,
  ResolveBusinessQrActionsResultDto,
} from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { publicApiFetch } from '@/lib/public-api-client';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import type { SettlementAccessView, SettlementView } from '@/lib/settlement-types';

export interface SettlementState {
  businessQrToken?: string;
  accessAuthorizationId?: string;
  error?: string;
  success?: boolean;
  qr?: QrResolveDto & { businessId: string };
  access?: {
    authorization: { id: string; expiresAt: string };
    settlement: { id: string; expiresAt: string };
  };
  inspected?: SettlementAccessView;
  settlements?: SettlementView[];
  allowedActions?: string[];
  review?: SettlementView;
  businessId?: string;
  branchId?: string | undefined;
}
function failure(err: unknown): SettlementState {
  rethrowControlFlow(err);
  return {
    error: err instanceof ApiError ? err.message : 'Unable to complete settlement. Try again.',
  };
}
function consent(form: FormData) {
  if (form.get('consent') !== 'on') throw new ApiError('Explicit consent is required.', 400);
}
function field(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

export async function customerSettlementAccessAction(
  claimId: string,
  _prev: SettlementState,
  form: FormData,
): Promise<SettlementState> {
  try {
    const token = field(form, 'businessQrToken');
    const details = await publicApiFetch<QrResolveDto>(`/qr/${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
    const resolved = await customerApiFetch<ResolveBusinessQrActionsResultDto>(
      '/loyalty/me/actions/resolve-business',
      {
        method: 'POST',
        cache: 'no-store',
        body: JSON.stringify({ businessQrToken: token }),
      },
    );
    if (!resolved.actions.includes('SETTLE_ORPHAN_REWARD'))
      throw new ApiError('Settlement is not eligible at this business.', 403);
    const qr = { ...details, businessId: resolved.businessId };
    // Preview first; require the same resolved business at the explicit consent
    // submission. The core service rechecks claim ownership and eligibility.
    if (field(form, 'operation') === 'preview') return { qr, businessQrToken: token };
    if (
      field(form, 'operation') !== 'authorize' ||
      field(form, 'reviewedBusinessId') !== qr.businessId
    ) {
      throw new ApiError('Review the receiving business before authorizing access.', 409);
    }
    consent(form);
    const access = await customerApiFetch<NonNullable<SettlementState['access']>>(
      `/orphan-claims/me/${encodeURIComponent(claimId)}/authorize-access`,
      {
        method: 'POST',
        body: JSON.stringify({
          receivingBusinessId: qr.businessId,
          consentVersion: 'split06-settlement-access-v1',
          correlationId: field(form, 'requestKey'),
          idempotencyKey: field(form, 'requestKey'),
        }),
      },
    );
    return { qr, access, businessQrToken: token };
  } catch (err) {
    return failure(err);
  }
}

export async function customerSettlementReviewAction(
  settlementId: string,
  _prev: SettlementState,
  form: FormData,
): Promise<SettlementState> {
  try {
    const path = `/orphan-settlements/${encodeURIComponent(settlementId)}`;
    const { settlement } = await customerApiFetch<{ settlement: SettlementView }>(path, {
      cache: 'no-store',
    });
    const operation = field(form, 'operation');
    if (operation === 'refresh') return { review: settlement };
    if (operation === 'cancel') {
      await customerApiFetch(`${path}/cancel`, { method: 'POST' });
      const current = await customerApiFetch<{ settlement: SettlementView }>(path, {
        cache: 'no-store',
      });
      return { success: true, review: current.settlement };
    }
    if (operation !== 'complete') throw new ApiError('Unknown settlement action.', 400);
    consent(form);
    // Do not silently acknowledge a newer contract than the customer saw.
    if (
      field(form, 'reviewedContract') !==
      JSON.stringify({
        policy: settlement.fulfillmentPolicyVersion,
        reference: settlement.fulfillmentReference,
        snapshot: settlement.fulfillmentSnapshot,
      })
    ) {
      throw new ApiError('The benefit changed. Refresh and review it before consenting.', 409);
    }
    await customerApiFetch(`${path}/authorize-completion`, {
      method: 'POST',
      body: JSON.stringify({
        correlationId: field(form, 'requestKey'),
        idempotencyKey: field(form, 'requestKey'),
        fulfillmentPolicyVersion: settlement.fulfillmentPolicyVersion,
        fulfillmentReference: settlement.fulfillmentReference,
      }),
    });
    const current = await customerApiFetch<{ settlement: SettlementView }>(path, {
      cache: 'no-store',
    });
    return { success: true, review: current.settlement };
  } catch (err) {
    return failure(err);
  }
}

export async function businessSettlementAction(
  _prev: SettlementState,
  form: FormData,
): Promise<SettlementState> {
  try {
    const business = await getActiveBusiness();
    if (
      !business ||
      (field(form, 'reviewedBusinessId') && field(form, 'reviewedBusinessId') !== business.id)
    ) {
      throw new ApiError('Business context changed. Reload settlement actions.', 403);
    }
    const scope = {
      businessId: business.id,
      ...(field(form, 'branchId') ? { branchId: field(form, 'branchId') } : {}),
      cache: 'no-store' as const,
    };
    const operation = field(form, 'operation');
    if (operation === 'list') {
      const list = await apiFetch<{ settlements: SettlementView[]; allowedActions: string[] }>(
        '/settlements',
        scope,
      );
      return { ...list, businessId: business.id, branchId: scope.branchId };
    }
    const settlementId = field(form, 'settlementId');
    const authorizationId = field(form, 'authorizationId');
    if (operation === 'inspect') {
      const inspected = await apiFetch<SettlementAccessView>('/settlements/access', {
        ...scope,
        method: 'POST',
        body: JSON.stringify({ settlementId, authorizationId }),
      });
      const list = await apiFetch<{ allowedActions: string[] }>('/settlements', scope);
      return {
        inspected,
        accessAuthorizationId: authorizationId,
        allowedActions: list.allowedActions,
        businessId: business.id,
        branchId: scope.branchId,
      };
    }
    if (operation === 'accept') {
      consent(form);
      await apiFetch(`/settlements/${encodeURIComponent(settlementId)}/accept`, {
        ...scope,
        method: 'POST',
        body: JSON.stringify({
          authorizationId,
          fulfillment: {
            benefitType: field(form, 'benefitType'),
            title: field(form, 'title'),
            description: field(form, 'description'),
            ...(field(form, 'terms') ? { terms: field(form, 'terms') } : {}),
            ...(field(form, 'reference') ? { reference: field(form, 'reference') } : {}),
          },
        }),
      });
    } else if (operation === 'fulfill') {
      consent(form);
      // Split 06 resolves the completion authorization and exact snapshot inside
      // its transaction. No client-provided authorization can replace that proof.
      await apiFetch(`/settlements/${encodeURIComponent(settlementId)}/fulfill`, {
        ...scope,
        method: 'POST',
      });
    } else {
      throw new ApiError('Unknown settlement action.', 400);
    }
    const list = await apiFetch<{ settlements: SettlementView[]; allowedActions: string[] }>(
      '/settlements',
      scope,
    );
    return { ...list, success: true, businessId: business.id, branchId: scope.branchId };
  } catch (err) {
    return failure(err);
  }
}
