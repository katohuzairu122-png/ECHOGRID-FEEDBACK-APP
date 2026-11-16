import { afterEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import {
  CUSTOMER_QR_TOKEN_TTL_SECONDS,
  isCustomerQrRevoked,
  signCustomerQrToken,
  verifyCustomerQrToken,
} from './customer-qr-token';

const SECRET = 'customer-qr-test-secret';
const CUSTOMER_ID = crypto.randomUUID();

describe('customer QR token', () => {
  afterEach(() => vi.useRealTimers());

  it('identifies only the customer and token purpose', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    const payload = await verifyCustomerQrToken(token, SECRET);

    expect(payload.sub).toBe(CUSTOMER_ID);
    expect(payload.type).toBe('qr_customer');
    expect(payload.exp).toBeGreaterThan(payload.iat);

    const rawPayload = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(rawPayload).not.toHaveProperty('points');
    expect(rawPayload).not.toHaveProperty('rewards');
    expect(rawPayload).not.toHaveProperty('memberships');
    expect(rawPayload).not.toHaveProperty('businessId');
  });

  it('expires after the short-lived display window', async () => {
    vi.useFakeTimers();
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    vi.setSystemTime(Date.now() + (CUSTOMER_QR_TOKEN_TTL_SECONDS + 1) * 1000);
    await expect(verifyCustomerQrToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    await expect(verifyCustomerQrToken(token, 'wrong-secret')).rejects.toThrow();
  });

  it('is valid for 24 hours: usable late in the window, expired just after it', async () => {
    expect(CUSTOMER_QR_TOKEN_TTL_SECONDS).toBe(24 * 60 * 60);
    vi.useFakeTimers();
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    vi.setSystemTime(Date.now() + (CUSTOMER_QR_TOKEN_TTL_SECONDS - 60) * 1000);
    await expect(verifyCustomerQrToken(token, SECRET)).resolves.toMatchObject({ sub: CUSTOMER_ID });
    vi.setSystemTime(Date.now() + 120 * 1000);
    await expect(verifyCustomerQrToken(token, SECRET)).rejects.toThrow();
  });

  it('can be verified repeatedly: verification consumes nothing', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET);
    for (let i = 0; i < 5; i += 1) {
      await expect(verifyCustomerQrToken(token, SECRET)).resolves.toMatchObject({ sub: CUSTOMER_ID });
    }
  });

  it('binds the revocation epoch and treats a missing epoch as zero', async () => {
    const issued = await verifyCustomerQrToken(await signCustomerQrToken(CUSTOMER_ID, SECRET, 3), SECRET);
    expect(issued.rev).toBe(3);
    expect(isCustomerQrRevoked(issued, 3)).toBe(false);
    expect(isCustomerQrRevoked(issued, 4)).toBe(true);
    expect(isCustomerQrRevoked({}, 0)).toBe(false);
    expect(isCustomerQrRevoked({}, 1)).toBe(true);
  });

  it('rejects malformed revocation epochs and a wrong token type', async () => {
    const base = { sub: CUSTOMER_ID, type: 'qr_customer', sigVer: 1, nonce: 'n', iat: Math.floor(Date.now() / 1000) };
    const exp = base.iat + 600;
    for (const rev of [-1, 1.5, '1', null]) {
      const token = await sign({ ...base, rev, exp }, SECRET, 'HS256');
      await expect(verifyCustomerQrToken(token, SECRET)).rejects.toThrow();
    }
    const wrongType = await sign({ ...base, type: 'qr_business', exp }, SECRET, 'HS256');
    await expect(verifyCustomerQrToken(wrongType, SECRET)).rejects.toThrow();
  });

  it('carries no permanent authorization material', async () => {
    const token = await signCustomerQrToken(CUSTOMER_ID, SECRET, 2);
    const raw = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['exp', 'iat', 'nonce', 'rev', 'sigVer', 'sub', 'type']);
  });
});
