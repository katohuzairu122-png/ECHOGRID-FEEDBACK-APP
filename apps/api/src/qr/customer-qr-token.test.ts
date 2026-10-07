import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_QR_TOKEN_TTL_SECONDS,
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
});
