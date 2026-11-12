import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn(), business: vi.fn() }));
vi.mock('@/lib/api-client', async () => ({
  apiFetch: mocks.api,
  ...(await import('@/lib/api-error')),
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: mocks.business }));
import {
  resolveStaffQrAction,
  staffLookupPurchaseAction,
  staffQrTransactionAction,
  staffUnifiedQrAction,
} from './unified-qr';
import { ApiError } from '@/lib/api-error';
import { classifyQrFailure } from '@/lib/qr-failure';

const result = {
  customerId: 'customer',
  loyaltyAccountId: 'account',
  membershipStatus: 'active',
  actions: ['VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS', 'REDEEM_REWARD'],
};
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.business.mockResolvedValue({ id: 'business' });
  mocks.api.mockResolvedValue(result);
});
describe('scanner and paste input cleaning', () => {
  it('strips whitespace and control characters a scanner or paste adds around the code', async () => {
    const state = await resolveStaffQrAction(
      {},
      form({ operation: 'resolve', token: '\u0002 aaa.bbb.ccc \r\n', branchId: '' }),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      '/loyalty/actions/resolve-customer',
      expect.objectContaining({ body: JSON.stringify({ customerQrToken: 'aaa.bbb.ccc' }) }),
    );
    expect(state.token).toBe('aaa.bbb.ccc');
  });
});

const lookupResult = {
  lookupToken: 'lookup.token.value',
  displayName: 'Amina',
  phoneMasked: '+•••••••4567',
  membershipStatus: 'active',
  actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS'],
};

describe('phone lookup (D-C2)', () => {
  it('looks a customer up by an exact E.164 number and keeps only the lookup handle', async () => {
    mocks.api.mockResolvedValue(lookupResult);
    const state = await resolveStaffQrAction(
      {},
      form({ operation: 'resolve', token: '+1 (555) 123-4567', branchId: 'branch' }),
    );
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith(
      '/loyalty/actions/lookup-customer',
      expect.objectContaining({
        businessId: 'business',
        branchId: 'branch',
        method: 'POST',
        body: JSON.stringify({ phone: '+15551234567' }),
      }),
    );
    expect(state.lookup).toEqual(lookupResult);
    expect(state.result).toBeUndefined();
    expect(state.token).toBeUndefined();
    expect(state.purchaseRequestKey).toBeTruthy();
  });

  it('does not guess a country code and makes no request', async () => {
    const state = await resolveStaffQrAction({}, form({ operation: 'resolve', token: '5551234567' }));
    expect(state.errorKind).toBe('phoneCountryCode');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it.each(['hello', 'abc.def', '', '   '])('rejects %j without a request', async (value) => {
    const state = await resolveStaffQrAction({}, form({ operation: 'resolve', token: value }));
    expect(state.errorKind).toBe('unrecognizedInput');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('keeps a scanned token on the existing resolve path', async () => {
    mocks.api.mockResolvedValue(result);
    const state = await resolveStaffQrAction(
      {},
      form({ operation: 'resolve', token: 'aaa.bbb.ccc', branchId: '' }),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      '/loyalty/actions/resolve-customer',
      expect.objectContaining({ body: JSON.stringify({ customerQrToken: 'aaa.bbb.ccc' }) }),
    );
    expect(state.result).toEqual(result);
    expect(state.lookup).toBeUndefined();
  });

  it('surfaces a miss with its own error kind', async () => {
    mocks.api.mockRejectedValue(new ApiError('No member found.', 404, 'MEMBER_NOT_FOUND'));
    const state = await resolveStaffQrAction({}, form({ operation: 'resolve', token: '+15551234567' }));
    expect(state.errorKind).toBe('memberNotFound');
    expect(state.lookup).toBeUndefined();
  });

  it('records a lookup purchase with the lookup token only, never an account id', async () => {
    mocks.api.mockResolvedValue({ success: true });
    const state = await staffUnifiedQrAction(
      { lookup: lookupResult as never },
      form({
        operation: 'lookup-purchase',
        lookupToken: 'lookup.token.value',
        businessId: 'business',
        branchId: 'branch',
        purchaseAmount: '12.5',
        idempotencyKey: 'lookup-request-1',
      }),
    );
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith(
      '/loyalty/actions/lookup-purchase',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          lookupToken: 'lookup.token.value',
          purchaseAmount: 12.5,
          idempotencyKey: 'lookup-request-1',
        }),
      }),
    );
    expect(JSON.stringify(mocks.api.mock.calls)).not.toContain('account');
    expect(state.success).toBe(true);
    expect(state.purchaseCompleted).toBe(true);
    expect(state.lookup).toEqual(lookupResult);
  });

  it('denies a lookup purchase when the business context changed, without calling the API', async () => {
    mocks.business.mockResolvedValue({ id: 'another-business' });
    const state = await staffLookupPurchaseAction(
      {},
      form({
        operation: 'lookup-purchase',
        lookupToken: 'lookup.token.value',
        businessId: 'business',
        purchaseAmount: '12',
        idempotencyKey: 'k',
      }),
    );
    expect(state.error).toContain('Business context changed');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('reports an expired lookup and a reached cap with their own kinds, and keeps the purchase key', async () => {
    const base = form({
      operation: 'lookup-purchase',
      lookupToken: 'lookup.token.value',
      businessId: 'business',
      purchaseAmount: '12',
      idempotencyKey: 'stable-lookup-key',
    });
    mocks.api.mockRejectedValueOnce(new ApiError('expired', 404, 'LOOKUP_EXPIRED'));
    const expired = await staffLookupPurchaseAction({}, base);
    expect(expired.errorKind).toBe('lookupExpired');
    expect(expired.purchaseRequestKey).toBe('stable-lookup-key');
    mocks.api.mockRejectedValueOnce(new ApiError('cap', 429, 'LOOKUP_PURCHASE_CAP_REACHED'));
    const capped = await staffLookupPurchaseAction({}, base);
    expect(capped.errorKind).toBe('lookupCap');
  });
});

describe('staff QR action authorization', () => {
  it('never trusts permissions carried in posted action state', async () => {
    mocks.api.mockResolvedValue({ ...result, actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'] });
    const state = await staffUnifiedQrAction(
      { result: { ...result, membershipStatus: 'active', actions: ['GRANT_LOYALTY_PROGRESS'] } },
      form({
        operation: 'purchase',
        token: 'qr',
        businessId: 'business',
        purchaseAmount: '12',
        idempotencyKey: 'request-123',
      }),
    );
    expect(state.error).toContain('not permitted');
    expect(state.result?.actions).toEqual(['VIEW_ALLOWED_MEMBERSHIP_STATE']);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it('preserves the purchase key across an uncertain response and rotates it only for a new completed-purchase resolution', async () => {
    mocks.api
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new ApiError('Connection interrupted', 500));
    const failed = await staffQrTransactionAction(
      'qr.test.token',
      'branch',
      'business',
      {},
      form({ operation: 'purchase', purchaseAmount: '12', idempotencyKey: 'stable-request-key' }),
    );
    expect(failed.purchaseRequestKey).toBe('stable-request-key');
    const retry = await resolveStaffQrAction(failed, form({ token: 'qr.test.token', branchId: 'branch' }));
    expect(retry.purchaseRequestKey).toBe('stable-request-key');
    const next = await resolveStaffQrAction(
      { ...retry, purchaseCompleted: true },
      form({ token: 'qr.test.token', branchId: 'branch' }),
    );
    expect(next.purchaseRequestKey).not.toBe('stable-request-key');
  });
  it('only resolves on a scan; never writes a purchase or redemption', async () => {
    await resolveStaffQrAction({}, form({ token: 'signed.qr.token', branchId: 'branch' }));
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith(
      '/loyalty/actions/resolve-customer',
      expect.objectContaining({ businessId: 'business', branchId: 'branch' }),
    );
  });
  it('fails closed when a token expires before a purchase', async () => {
    mocks.api.mockRejectedValue(new ApiError('Expired QR', 404));
    const state = await staffQrTransactionAction(
      'expired',
      'branch',
      'business',
      {},
      form({ operation: 'purchase' }),
    );
    expect(state.error).toBe('Expired QR');
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it('denies changed business context before resolving customer information', async () => {
    const state = await staffQrTransactionAction(
      'qr',
      '',
      'foreign-business',
      {},
      form({ operation: 'purchase' }),
    );
    expect(state.error).toContain('Business context changed');
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('denies a purchase without server-approved permissions', async () => {
    mocks.api.mockResolvedValue({ ...result, actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'] });
    const state = await staffQrTransactionAction(
      'qr',
      '',
      'business',
      {},
      form({ operation: 'purchase' }),
    );
    expect(state.error).toContain('not permitted');
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it('uses the freshly resolved account, never a posted account ID', async () => {
    await staffQrTransactionAction(
      'qr',
      'branch',
      'business',
      {},
      form({
        operation: 'purchase',
        accountId: 'foreign',
        purchaseAmount: '12.5',
        idempotencyKey: 'request-123',
      }),
    );
    expect(mocks.api).toHaveBeenLastCalledWith(
      '/loyalty/accounts/account/purchase',
      expect.objectContaining({
        businessId: 'business',
        branchId: 'branch',
        body: JSON.stringify({
          purchaseAmount: 12.5,
          idempotencyKey: 'request-123',
          channel: 'other',
        }),
      }),
    );
  });
  it('does not expose or confirm another customer’s redemption', async () => {
    mocks.api
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({ loyaltyAccountId: 'other-account' });
    const state = await staffQrTransactionAction(
      'qr',
      '',
      'business',
      {},
      form({ operation: 'lookup', code: 'CODE1234' }),
    );
    expect(state.error).toContain('does not belong');
    expect(state.transaction).toBeUndefined();
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
  it('requires review of the same code before confirmation', async () => {
    mocks.api
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({ loyaltyAccountId: 'account', redemptionCode: 'CODE1234' });
    const state = await staffQrTransactionAction(
      'qr',
      '',
      'business',
      {},
      form({ operation: 'confirm', code: 'CODE1234', reviewedCode: 'DIFFERENT' }),
    );
    expect(state.error).toContain('Review this reward');
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
  it('preserves authentication redirects', async () => {
    const redirect = { digest: 'NEXT_REDIRECT;replace;/login;307;' };
    mocks.business.mockRejectedValue(redirect);
    await expect(resolveStaffQrAction({}, form({ token: 'qr.test.token' }))).rejects.toBe(redirect);
  });
});

describe('classifyQrFailure', () => {
  it.each([
    [new ApiError('x', 401), 'session'],
    [new ApiError('x', 429), 'rateLimited'],
    [new ApiError('x', 404, 'CUSTOMER_QR_NOT_FOUND'), 'invalidQr'],
    [new ApiError('x', 403, 'BRANCH_ACCESS_DENIED'), 'branch'],
    [new ApiError('x', 403, 'PERMISSION_DENIED'), 'permission'],
    [new ApiError('x', 500), 'unavailable'],
    [new Error('network'), 'unavailable'],
    [new ApiError('x', 403, 'BUSINESS_CONTEXT_CHANGED'), 'other'],
  ])('%#', (err, kind) => {
    expect(classifyQrFailure(err)).toBe(kind);
  });
});

describe('classifyQrFailure phone lookup kinds', () => {
  it.each([
    [new ApiError('x', 404, 'MEMBER_NOT_FOUND'), 'memberNotFound'],
    [new ApiError('x', 404, 'LOOKUP_EXPIRED'), 'lookupExpired'],
    [new ApiError('x', 429, 'LOOKUP_THROTTLED'), 'lookupThrottled'],
    [new ApiError('x', 429, 'LOOKUP_PURCHASE_CAP_REACHED'), 'lookupCap'],
    [new ApiError('x', 429, 'RATE_LIMITED'), 'rateLimited'],
  ])('maps %# to %s', (err, kind) => {
    expect(classifyQrFailure(err)).toBe(kind);
  });
});
