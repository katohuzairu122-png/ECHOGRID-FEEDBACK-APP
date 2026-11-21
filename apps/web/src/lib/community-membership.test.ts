import { beforeEach, expect, it, vi } from 'vitest';
import { getCommunityPhoneEligibility } from './community-membership';
import { customerApiFetch } from './customer-api-client';
vi.mock('server-only', () => ({}));
vi.mock('./customer-api-client', () => ({ customerApiFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it.each([[true, 'verified'], [false, 'unverified'], ['true', 'unavailable'], [undefined, 'unavailable']])('uses authoritative boolean %s only', async (verified, expected) => {
  vi.mocked(customerApiFetch).mockResolvedValue({ verified, phoneMasked: 'private' });
  expect(await getCommunityPhoneEligibility()).toBe(expected);
  expect(customerApiFetch).toHaveBeenCalledWith('/loyalty/me/phone', { cache: 'no-store' }, '/loyalty/dashboard/community');
});
it('reports an outage rather than granting eligibility', async () => {
  vi.mocked(customerApiFetch).mockRejectedValue(new Error('unavailable'));
  expect(await getCommunityPhoneEligibility()).toBe('unavailable');
});
it('does not swallow authentication redirect', async () => {
  const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' });
  vi.mocked(customerApiFetch).mockRejectedValue(redirect);
  await expect(getCommunityPhoneEligibility()).rejects.toBe(redirect);
});
