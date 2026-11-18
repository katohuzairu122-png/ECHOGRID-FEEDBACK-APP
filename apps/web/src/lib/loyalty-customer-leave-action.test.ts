import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
const customerApiFetch = vi.fn();
vi.mock('@/lib/customer-api-client', () => ({
  customerApiFetch: (...a: unknown[]) => customerApiFetch(...a),
}));
// The action only needs the error class from api-client; keep the session/cookie machinery out of this unit test.
vi.mock('@/lib/api-client', async () => ({ ApiError: (await import('./api-error')).ApiError }));

import { ApiError } from './api-error';
import { leaveLoyaltyAction } from './actions/loyalty-customer';

const BUSINESS = 'business-1';

describe('leaveLoyaltyAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks the API to end the caller’s membership with that business, then refreshes the pages that show it', async () => {
    customerApiFetch.mockResolvedValue({ id: 'm-1', status: 'left' });

    await expect(leaveLoyaltyAction(BUSINESS)).resolves.toEqual({ left: true });

    expect(customerApiFetch).toHaveBeenCalledExactlyOnceWith(
      '/customer-memberships/business-1/leave',
      { method: 'POST' },
    );
    expect(revalidatePath).toHaveBeenCalledWith('/loyalty/dashboard');
    expect(revalidatePath).toHaveBeenCalledWith('/loyalty/dashboard/business-1');
  });

  it('turns an API refusal into state the dashboard can show, keeping the code, and refreshes nothing', async () => {
    customerApiFetch.mockRejectedValue(
      new ApiError(
        'This membership cannot be left by the customer.',
        409,
        'MEMBERSHIP_NOT_LEAVABLE',
      ),
    );

    await expect(leaveLoyaltyAction(BUSINESS)).resolves.toEqual({
      error: 'This membership cannot be left by the customer.',
      code: 'MEMBERSHIP_NOT_LEAVABLE',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('omits the code when the API error had none', async () => {
    customerApiFetch.mockRejectedValue(new ApiError('Service unavailable.', 503));

    const result = await leaveLoyaltyAction(BUSINESS);

    expect(result).toEqual({ error: 'Service unavailable.' });
    expect('code' in result).toBe(false);
  });

  it('reports a generic failure for an unexpected error', async () => {
    customerApiFetch.mockRejectedValue(new Error('network down'));

    await expect(leaveLoyaltyAction(BUSINESS)).resolves.toEqual({
      error: 'Something went wrong. Please try again.',
    });
  });

  it('re-throws a session redirect so an expired login still goes to the sign-in page', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;',
    });
    customerApiFetch.mockRejectedValue(redirect);

    await expect(leaveLoyaltyAction(BUSINESS)).rejects.toBe(redirect);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
