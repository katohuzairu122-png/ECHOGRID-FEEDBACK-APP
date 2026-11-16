import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { signClientAttribution } from '../lib/client-attribution';
import { openRecoveryDependencies, resolveRecoveryTrustedSource } from './customer-recovery.composition';

const RECOVERY = 'recovery-secret-with-at-least-thirty-two-bytes!!';
const ATTRIBUTION = 'attribution-secret-for-the-web-worker-signature';
const ctx = (env: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ({ env, req: { raw: new Request('https://api.test/customer-recovery/initiate', { method: 'POST', headers }) } }) as unknown as Context;
const signed = (ip: string, at = Date.now()) => signClientAttribution(ATTRIBUTION, { ip, userAgent: 'test' }, at);

describe('recovery trusted source', () => {
  const env = { CUSTOMER_RECOVERY_HMAC_SECRET: RECOVERY, CLIENT_ATTRIBUTION_SECRET: ATTRIBUTION };

  it('yields an opaque keyed digest only for a verified, fresh attribution from the web Worker', async () => {
    const source = await resolveRecoveryTrustedSource(ctx(env, { 'x-echo-client': await signed('192.0.2.7') }));
    expect(source).toMatch(/^[0-9a-f]{64}$/);
    expect(source).not.toContain('192.0.2.7');
    expect(await resolveRecoveryTrustedSource(ctx(env, { 'x-echo-client': await signed('192.0.2.7') }))).toBe(source);
    expect(await resolveRecoveryTrustedSource(ctx(env, { 'x-echo-client': await signed('192.0.2.8') }))).not.toBe(source);
  });

  it('rejects a missing, unsigned, forged, stale or malformed source', async () => {
    // Alter the SECOND-to-last character: the last base64url character of a 32-byte signature carries two unused padding
    // bits, so swapping it (A<->B, or any of A-D for A) can decode to identical bytes and leave the signature valid,
    // which made this case fail about 1 run in 16. Every bit of the second-to-last character is significant.
    const valid = await signed('192.0.2.7');
    const forged = valid.replace(/.(?=.$)/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(forged).not.toBe(valid);
    for (const headers of [
      {},
      { 'cf-connecting-ip': '192.0.2.7', 'x-forwarded-for': '192.0.2.7' }, // an unsigned address is never trusted
      { 'x-echo-client': 'forged' },
      { 'x-echo-client': forged },
      { 'x-echo-client': await signed('192.0.2.7', Date.now() - 10 * 60_000) },
      { 'x-echo-client': await signed('not an ip; drop table') },
    ]) expect(await resolveRecoveryTrustedSource(ctx(env, headers))).toBeNull();
  });

  it('is unavailable without the attribution secret or the dedicated recovery secret, or with a reused one', async () => {
    const header = { 'x-echo-client': await signed('192.0.2.7') };
    expect(await resolveRecoveryTrustedSource(ctx({ CUSTOMER_RECOVERY_HMAC_SECRET: RECOVERY }, header))).toBeNull();
    expect(await resolveRecoveryTrustedSource(ctx({ CLIENT_ATTRIBUTION_SECRET: ATTRIBUTION }, header))).toBeNull();
    expect(await resolveRecoveryTrustedSource(ctx({ ...env, CUSTOMER_RECOVERY_HMAC_SECRET: 'short' }, header))).toBeNull();
    expect(await resolveRecoveryTrustedSource(ctx({ ...env, CUSTOMER_JWT_SECRET: RECOVERY }, header))).toBeNull();
  });
});

describe('recovery dependency construction fails closed', () => {
  const base = {
    CUSTOMER_RECOVERY_HMAC_SECRET: RECOVERY, CUSTOMER_PASSWORD_MIN_LENGTH: '10', WEB_BASE_URL: 'https://app.example.test',
    HYPERDRIVE: { connectionString: 'postgres://invalid' }, PASSWORD_HASHER: {},
  } as Record<string, unknown>;

  it.each([
    ['no password minimum (owner decision CA-05, no default)', { CUSTOMER_PASSWORD_MIN_LENGTH: undefined }],
    ['a non-integer password minimum', { CUSTOMER_PASSWORD_MIN_LENGTH: '12abc' }],
    ['no web base URL', { WEB_BASE_URL: '' }],
    ['a plain-http web base URL outside localhost', { WEB_BASE_URL: 'http://app.example.test' }],
    ['no Hyperdrive binding', { HYPERDRIVE: undefined }],
    ['no password hasher', { PASSWORD_HASHER: undefined }],
  ] as Array<[string, Record<string, unknown>]>)('returns nothing (so the route answers 503) with %s, before opening a database', async (_label, over) => {
    expect(await openRecoveryDependencies(ctx({ ...base, ...over }))).toBeNull();
  });

  it('throws on a missing or weak recovery secret instead of falling back', async () => {
    await expect(openRecoveryDependencies(ctx({ ...base, CUSTOMER_RECOVERY_HMAC_SECRET: undefined }))).rejects.toThrow();
    await expect(openRecoveryDependencies(ctx({ ...base, CUSTOMER_RECOVERY_HMAC_SECRET: 'short' }))).rejects.toThrow();
  });
});
