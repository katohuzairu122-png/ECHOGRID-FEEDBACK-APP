import { describe, it, expect } from 'vitest';
import { signCustomerAccessToken, verifyCustomerAccessToken, CUSTOMER_ACCESS_TOKEN_TTL_SECONDS } from './customer-jwt';
import { signAccessToken } from '../auth/jwt';

const SECRET = 'customer-test-secret-do-not-use-in-production';
const OTHER_SECRET = 'a-different-secret';

describe('customer access tokens', () => {
  it('round-trips: sign then verify returns the same customerId', async () => {
    const token = await signCustomerAccessToken('customer-123', SECRET);
    const payload = await verifyCustomerAccessToken(token, SECRET);
    expect(payload.sub).toBe('customer-123');
    expect(payload.type).toBe('customer_access');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signCustomerAccessToken('customer-123', SECRET);
    await expect(verifyCustomerAccessToken(token, OTHER_SECRET)).rejects.toThrow();
  });

  it('returns an expiry roughly 90 days out, matching CUSTOMER_ACCESS_TOKEN_TTL_SECONDS', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signCustomerAccessToken('customer-123', SECRET);
    const payload = await verifyCustomerAccessToken(token, SECRET);
    expect(payload.exp - before).toBeGreaterThanOrEqual(CUSTOMER_ACCESS_TOKEN_TTL_SECONDS - 5);
    expect(payload.exp - before).toBeLessThanOrEqual(CUSTOMER_ACCESS_TOKEN_TTL_SECONDS + 5);
  });

  it('a staff access token cannot verify as a customer token, even with the same secret -- the `type` field is real defense in depth on top of the separate CUSTOMER_JWT_SECRET', async () => {
    const staffToken = await signAccessToken('user-123', SECRET);
    await expect(verifyCustomerAccessToken(staffToken, SECRET)).rejects.toThrow();
  });
});
