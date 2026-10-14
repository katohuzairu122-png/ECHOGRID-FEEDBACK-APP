import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  customer: vi.fn(),
  public: vi.fn(),
  business: vi.fn(),
}));
vi.mock('@/lib/api-client', async () => ({
  apiFetch: mocks.api,
  ...(await import('@/lib/api-error')),
}));
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: mocks.customer }));
vi.mock('@/lib/public-api-client', () => ({ publicApiFetch: mocks.public }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: mocks.business }));
import {
  businessSettlementAction,
  customerSettlementAccessAction,
  customerSettlementReviewAction,
} from './settlements';
import { ApiError } from '@/lib/api-error';
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}
const review = {
  id: 'settlement',
  status: 'reserved',
  fulfillmentPolicyVersion: 'policy-v1',
  fulfillmentReference: 'reference',
  fulfillmentSnapshot: { title: 'Reviewed benefit' },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.business.mockResolvedValue({ id: 'receiver' });
  mocks.public.mockResolvedValue({ businessName: 'Receiver', branchName: 'Branch' });
  mocks.customer.mockResolvedValue({ businessId: 'receiver', actions: ['SETTLE_ORPHAN_REWARD'] });
});
describe('explicit orphan settlement consent and scope', () => {
  it('QR preview does not create consent, reserve or fulfill', async () => {
    const state = await customerSettlementAccessAction(
      'claim',
      {},
      form({ operation: 'preview', businessQrToken: 'signed' }),
    );
    expect(state.qr?.businessId).toBe('receiver');
    expect(mocks.customer).toHaveBeenCalledTimes(1);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('denies access authorization without explicit customer consent', async () => {
    const state = await customerSettlementAccessAction(
      'claim',
      {},
      form({ operation: 'authorize', businessQrToken: 'signed', reviewedBusinessId: 'receiver' }),
    );
    expect(state.error).toContain('Explicit consent');
    expect(mocks.customer).toHaveBeenCalledTimes(1);
  });
  it('denies a changed receiving business', async () => {
    const state = await customerSettlementAccessAction(
      'claim',
      {},
      form({
        operation: 'authorize',
        businessQrToken: 'signed',
        reviewedBusinessId: 'other',
        consent: 'on',
      }),
    );
    expect(state.error).toContain('Review the receiving business');
    expect(mocks.customer).toHaveBeenCalledTimes(1);
  });
  it('does not authorize an ineligible receiver', async () => {
    mocks.customer.mockResolvedValue({ businessId: 'receiver', actions: [] });
    const state = await customerSettlementAccessAction(
      'claim',
      {},
      form({ operation: 'authorize', consent: 'on' }),
    );
    expect(state.error).toContain('not eligible');
    expect(mocks.customer).toHaveBeenCalledTimes(1);
  });
  it('requires exact acknowledgement of the reviewed benefit', async () => {
    mocks.customer.mockResolvedValue({ settlement: review });
    const state = await customerSettlementReviewAction(
      'settlement',
      {},
      form({ operation: 'complete', consent: 'on', reviewedContract: 'stale' }),
    );
    expect(state.error).toContain('benefit changed');
    expect(mocks.customer).toHaveBeenCalledTimes(1);
  });
  it('preserves expired, revoked or foreign authorization errors without writing again', async () => {
    mocks.api.mockRejectedValue(new ApiError('Authorization invalid or revoked', 409));
    const state = await businessSettlementAction(
      {},
      form({ operation: 'inspect', settlementId: 'foreign', authorizationId: 'revoked' }),
    );
    expect(state.error).toContain('invalid or revoked');
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it('requires independent business acceptance rather than treating inspection as acceptance', async () => {
    const state = await businessSettlementAction(
      {},
      form({ operation: 'accept', settlementId: 'settlement' }),
    );
    expect(state.error).toContain('Explicit consent');
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('denies changed business context before any claim lookup', async () => {
    const state = await businessSettlementAction(
      {},
      form({ operation: 'fulfill', reviewedBusinessId: 'foreign', consent: 'on' }),
    );
    expect(state.error).toContain('Business context changed');
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('requires separate explicit fulfillment confirmation', async () => {
    const state = await businessSettlementAction(
      {},
      form({ operation: 'fulfill', settlementId: 'settlement' }),
    );
    expect(state.error).toContain('Explicit consent');
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('preserves customer authentication redirects', async () => {
    const redirect = { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' };
    mocks.customer.mockRejectedValue(redirect);
    await expect(
      customerSettlementReviewAction('settlement', {}, form({ operation: 'refresh' })),
    ).rejects.toBe(redirect);
  });
});
