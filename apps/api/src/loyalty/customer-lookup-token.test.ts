import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import {
  CUSTOMER_LOOKUP_TOKEN_TYPE,
  signCustomerLookupToken,
  verifyCustomerLookupToken,
} from './customer-lookup-token';
import { signCustomerQrToken, verifyCustomerQrToken } from '../qr/customer-qr-token';

const SECRET = 'lookup-token-test-secret';
const input = {
  customerId: crypto.randomUUID(),
  businessId: crypto.randomUUID(),
  staffUserId: crypto.randomUUID(),
};

describe('customer lookup token', () => {
  it('round-trips and carries the binding claims', async () => {
    const token = await signCustomerLookupToken(input, SECRET);
    const payload = await verifyCustomerLookupToken(token, SECRET);
    expect(payload).toMatchObject({
      type: CUSTOMER_LOOKUP_TOKEN_TYPE,
      sub: input.customerId,
      bid: input.businessId,
      uid: input.staffUserId,
    });
    expect(payload.exp - payload.iat).toBe(120);
  });

  it('rejects a token signed with another secret, and accepts the previous secret', async () => {
    const token = await signCustomerLookupToken(input, 'old-secret');
    await expect(verifyCustomerLookupToken(token, SECRET)).rejects.toThrow();
    await expect(verifyCustomerLookupToken(token, SECRET, 'old-secret')).resolves.toBeTruthy();
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const token = await sign(
      {
        type: CUSTOMER_LOOKUP_TOKEN_TYPE,
        sub: input.customerId,
        bid: input.businessId,
        uid: input.staffUserId,
        nonce: 'n',
        iat: past,
        exp: past + 120,
      },
      SECRET,
      'HS256',
    );
    await expect(verifyCustomerLookupToken(token, SECRET)).rejects.toThrow();
  });

  it('is never accepted as a customer QR token, and a customer QR token is never accepted as a lookup token', async () => {
    const lookup = await signCustomerLookupToken(input, SECRET);
    await expect(verifyCustomerQrToken(lookup, SECRET)).rejects.toThrow();
    const qr = await signCustomerQrToken(input.customerId, SECRET);
    await expect(verifyCustomerLookupToken(qr, SECRET)).rejects.toThrow();
  });

  it('rejects a token with missing binding claims', async () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = await sign(
      { type: CUSTOMER_LOOKUP_TOKEN_TYPE, sub: input.customerId, nonce: 'n', iat, exp: iat + 60 },
      SECRET,
      'HS256',
    );
    await expect(verifyCustomerLookupToken(token, SECRET)).rejects.toThrow();
  });
});
