import { describe, expect, it } from 'vitest';
import { signClientAttribution } from '../lib/client-attribution';
import { createCustomerEmailTrustedSource } from './customer-email-trusted-source';

const now = 100_000;
const secret = 'attribution-test-key';
const resolve = createCustomerEmailTrustedSource({
  attributionSecret: secret,
  sourceKeySecret: 'test-source-key-long-enough-for-hmac',
  now: () => now,
});
const request = (signature = '') => new Request('https://example.test', {
  headers: { 'x-echo-client': signature, 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2' },
});
const sign = (ip: string, time = now) => signClientAttribution(secret, { ip, userAgent: 'test' }, time);

describe('customer email trusted source', () => {
  it('rejects missing, forged, stale and malformed attribution', async () => {
    for (const header of ['', 'forged', await sign('192.0.2.1', 0), await sign('::::')]) {
      expect(await resolve(request(header))).toBeNull();
    }
  });

  it('groups signed IPv6 clients by /64 without exposing their address', async () => {
    const first = await resolve(request(await sign('2001:db8::1')));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await resolve(request(await sign('2001:db8::2')))).toBe(first);
    expect(await resolve(request(await sign('2001:db8:1::2')))).not.toBe(first);
  });
});
