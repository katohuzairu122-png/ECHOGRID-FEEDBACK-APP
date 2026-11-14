import { describe, it, expect } from 'vitest';
import { assertCustomerNotLimited, isCustomerLimited } from './customer-limits';

const day = 86_400_000;
const repos = (limitedUntil: Date | null | undefined) => ({
  customers: { findById: async () => (limitedUntil === undefined ? undefined : { limitedUntil }) },
});

describe('isCustomerLimited', () => {
  it('is limited only while the end date is in the future', () => {
    expect(isCustomerLimited({ limitedUntil: new Date(Date.now() + day) })).toBe(true);
    expect(isCustomerLimited({ limitedUntil: new Date(Date.now() - day) })).toBe(false);
    expect(isCustomerLimited({ limitedUntil: null })).toBe(false);
    expect(isCustomerLimited({})).toBe(false);
  });
});

describe('assertCustomerNotLimited', () => {
  it('refuses a limited customer with CUSTOMER_LIMITED (403)', async () => {
    await expect(
      assertCustomerNotLimited(repos(new Date(Date.now() + day)), 'c1', 'surveys'),
    ).rejects.toMatchObject({
      status: 403,
      code: 'CUSTOMER_LIMITED',
    });
  });
  it('allows an unrestricted, expired-limit or unknown customer', async () => {
    await expect(assertCustomerNotLimited(repos(null), 'c1', 'surveys')).resolves.toBeUndefined();
    await expect(
      assertCustomerNotLimited(repos(new Date(Date.now() - day)), 'c1', 'join_business'),
    ).resolves.toBeUndefined();
    await expect(
      assertCustomerNotLimited(repos(undefined), 'c1', 'join_business'),
    ).resolves.toBeUndefined();
  });
});
