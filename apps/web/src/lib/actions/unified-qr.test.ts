import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn(), business: vi.fn() }));
vi.mock('@/lib/api-client', async () => ({
  apiFetch: mocks.api,
  ...(await import('@/lib/api-error')),
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: mocks.business }));
import { resolveStaffQrAction, staffQrTransactionAction, staffUnifiedQrAction } from './unified-qr';
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
      'qr',
      'branch',
      'business',
      {},
      form({ operation: 'purchase', purchaseAmount: '12', idempotencyKey: 'stable-request-key' }),
    );
    expect(failed.purchaseRequestKey).toBe('stable-request-key');
    const retry = await resolveStaffQrAction(failed, form({ token: 'qr', branchId: 'branch' }));
    expect(retry.purchaseRequestKey).toBe('stable-request-key');
    const next = await resolveStaffQrAction(
      { ...retry, purchaseCompleted: true },
      form({ token: 'qr', branchId: 'branch' }),
    );
    expect(next.purchaseRequestKey).not.toBe('stable-request-key');
  });
  it('only resolves on a scan; never writes a purchase or redemption', async () => {
    await resolveStaffQrAction({}, form({ token: 'signed-qr', branchId: 'branch' }));
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
    await expect(resolveStaffQrAction({}, form({ token: 'qr' }))).rejects.toBe(redirect);
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
