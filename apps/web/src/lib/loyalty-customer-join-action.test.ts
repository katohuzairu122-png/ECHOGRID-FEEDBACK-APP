import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const customerApiFetch = vi.fn();
vi.mock('@/lib/customer-api-client', () => ({
  customerApiFetch: (...a: unknown[]) => customerApiFetch(...a),
}));
// The action only needs the error class from api-client; keep the session/cookie machinery out of this unit test.
vi.mock('@/lib/api-client', async () => ({ ApiError: (await import('./api-error')).ApiError }));

import { ApiError } from './api-error';
import { joinAndCheckinAction, joinLoyaltyAction } from './actions/loyalty-customer';

const ACCOUNT = { id: 'acc-1', businessId: 'biz-1', points: 10 };

describe('joinLoyaltyAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the explicit acceptance and the consent wording version the customer was shown', async () => {
    customerApiFetch.mockResolvedValue({ loyaltyAccount: ACCOUNT });

    await expect(joinLoyaltyAction('qr-token', true)).resolves.toEqual(ACCOUNT);

    expect(customerApiFetch).toHaveBeenCalledWith(
      '/customer-memberships/join',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ qrToken: 'qr-token', consentAccepted: true, consentVersion: 'v1' }),
      }),
    );
  });

  it.each([[false], [undefined], ['true'], [1]])(
    'refuses %s without calling the API: the consent box is not the only guard',
    async (value) => {
      await expect(joinLoyaltyAction('qr-token', value as never)).rejects.toMatchObject({
        status: 400,
        code: 'CONSENT_REQUIRED',
      });
      expect(customerApiFetch).not.toHaveBeenCalled();
    },
  );
});

describe('joinAndCheckinAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not check in, and reports the refusal, when the join was not accepted', async () => {
    const result = await joinAndCheckinAction('qr-token', false);

    expect(result).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(result.account).toBeUndefined();
    expect(customerApiFetch).not.toHaveBeenCalled();
  });

  it('joins with consent, then checks in', async () => {
    customerApiFetch
      .mockResolvedValueOnce({ loyaltyAccount: ACCOUNT })
      .mockResolvedValueOnce(ACCOUNT);

    const result = await joinAndCheckinAction('qr-token', true);

    expect(result).toEqual({ account: ACCOUNT });
    expect(customerApiFetch).toHaveBeenNthCalledWith(
      1,
      '/customer-memberships/join',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(customerApiFetch).toHaveBeenNthCalledWith(
      2,
      '/loyalty/me/checkin',
      expect.objectContaining({ body: JSON.stringify({ qrToken: 'qr-token' }) }),
      '/loyalty/qr-token?autocheckin=1',
    );
  });

  it('surfaces an API refusal of the join (for example a missing verified phone) instead of checking in', async () => {
    customerApiFetch.mockRejectedValueOnce(
      new ApiError('Verify your phone number to continue.', 403, 'PHONE_VERIFICATION_REQUIRED'),
    );

    const result = await joinAndCheckinAction('qr-token', true);

    expect(result).toEqual({
      error: 'Verify your phone number to continue.',
      code: 'PHONE_VERIFICATION_REQUIRED',
    });
    expect(customerApiFetch).toHaveBeenCalledTimes(1);
  });
});
