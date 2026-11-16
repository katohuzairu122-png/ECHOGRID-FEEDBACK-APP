import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { getNetworkFeedEnabled } from './network-status';

vi.mock('server-only', () => ({}));
vi.mock('./customer-api-client', () => ({ customerApiFetch: vi.fn() }));
const customer = vi.mocked(customerApiFetch);

describe('getNetworkFeedEnabled', () => {
  beforeEach(() => customer.mockReset());

  it('is true only for an explicit enabled:true from the one status endpoint', async () => {
    customer.mockResolvedValue({ enabled: true } as never);
    expect(await getNetworkFeedEnabled()).toBe(true);
    expect(customer).toHaveBeenCalledWith('/network/status', { cache: 'no-store' });
  });

  it.each([{ enabled: false }, { enabled: 'true' }, { enabled: 1 }, {}, null])('hides the Feed for %j', async (value) => {
    customer.mockResolvedValue(value as never);
    expect(await getNetworkFeedEnabled()).toBe(false);
  });

  it('hides the Feed when the status call fails (never shown on a guess)', async () => {
    customer.mockRejectedValueOnce(new ApiError('down', 503, 'X'));
    expect(await getNetworkFeedEnabled()).toBe(false);
    customer.mockRejectedValueOnce(new Error('network'));
    expect(await getNetworkFeedEnabled()).toBe(false);
  });

  it('re-throws the login redirect instead of swallowing it', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' });
    customer.mockRejectedValueOnce(redirect);
    await expect(getNetworkFeedEnabled()).rejects.toBe(redirect);
  });
});
