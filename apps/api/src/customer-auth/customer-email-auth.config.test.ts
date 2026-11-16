import { describe, expect, it } from 'vitest';
import type { Bindings } from '../config/env';
import { deriveEmailAuthSourceKey, isCustomerEmailAuthEnabled, parsePositiveIntSetting, resolveEmailAuthConfig } from './customer-email-auth.config';

const S1 = 'a'.repeat(40);
const S2 = 'b'.repeat(40);
const valid = (over: Record<string, unknown> = {}) => ({
  CUSTOMER_EMAIL_AUTH_ENABLED: 'true',
  CUSTOMER_EMAIL_AUTH_HMAC_SECRET: S1,
  CUSTOMER_SESSION_SIGNING_SECRET: S2,
  CUSTOMER_SESSION_ACCESS_TTL_SECONDS: '900',
  CUSTOMER_SESSION_REFRESH_TTL_SECONDS: '2592000',
  CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
  CUSTOMER_SESSION_IDLE_TTL_SECONDS: '1209600',
  CUSTOMER_STEP_UP_WINDOW_SECONDS: '300',
  CUSTOMER_PASSWORD_MIN_LENGTH: '12',
  CUSTOMER_JWT_SECRET: 'legacy-customer-jwt-secret-value-0123456789',
  CLIENT_ATTRIBUTION_SECRET: 'attribution-secret-value-0123456789abcdef',
  WEB_BASE_URL: 'https://app.example.test',
  HYPERDRIVE: {},
  PASSWORD_HASHER: {},
  CUSTOMER_AUTH_RATE_LIMIT: {},
  ...over,
}) as unknown as Bindings;

describe('email auth activation flag', () => {
  it('is on only for exactly "true"', () => {
    expect(isCustomerEmailAuthEnabled({ CUSTOMER_EMAIL_AUTH_ENABLED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'true ']) {
      expect(isCustomerEmailAuthEnabled({ CUSTOMER_EMAIL_AUTH_ENABLED: v })).toBe(false);
    }
  });
});

describe('strict integer settings', () => {
  it('accepts only positive plain integers', () => {
    expect(parsePositiveIntSetting('900')).toBe(900);
    for (const v of ['0', '-1', '1.5', '1e3', ' 9', '09', '', undefined, 900, '1234567890']) expect(parsePositiveIntSetting(v)).toBeNull();
  });
});

describe('resolveEmailAuthConfig', () => {
  it('resolves a complete, coherent configuration and wires the session settings', () => {
    const result = resolveEmailAuthConfig(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.passwordMinLength).toBe(12);
    expect(result.config.webBaseUrl).toBe('https://app.example.test');
    expect(result.config.session).toMatchObject({
      sessionSigningSecret: S2, accessTtlSeconds: 900, refreshTtlSeconds: 2592000, absoluteTtlSeconds: 2592000,
      idleTtlSeconds: 1209600, stepUpWindowSeconds: 300,
    });
    // The legacy 90-day token verifier keeps its own, different secret.
    expect(result.config.session.legacySigningSecret).not.toBe(result.config.session.sessionSigningSecret);
  });

  it.each([
    'CUSTOMER_EMAIL_AUTH_HMAC_SECRET', 'CUSTOMER_SESSION_SIGNING_SECRET', 'CUSTOMER_SESSION_ACCESS_TTL_SECONDS',
    'CUSTOMER_SESSION_REFRESH_TTL_SECONDS', 'CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS', 'CUSTOMER_SESSION_IDLE_TTL_SECONDS',
    'CUSTOMER_STEP_UP_WINDOW_SECONDS', 'CUSTOMER_PASSWORD_MIN_LENGTH', 'WEB_BASE_URL', 'HYPERDRIVE', 'PASSWORD_HASHER',
    'CUSTOMER_AUTH_RATE_LIMIT', 'CLIENT_ATTRIBUTION_SECRET', 'CUSTOMER_JWT_SECRET',
  ])('has no default: a missing %s makes it unavailable and names only the setting', (name) => {
    const env = valid({ [name]: undefined });
    const result = resolveEmailAuthConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain(name);
    expect(JSON.stringify(result)).not.toContain(S1);
    expect(JSON.stringify(result)).not.toContain(S2);
  });

  it('rejects a short secret and a secret reused by another binding (including the legacy JWT secret)', () => {
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_SIGNING_SECRET: 'short' })).ok).toBe(false);
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_SIGNING_SECRET: S1 })).ok).toBe(false); // equals the HMAC secret
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_SIGNING_SECRET: 'x'.repeat(40), CUSTOMER_JWT_SECRET: 'x'.repeat(40) })).ok).toBe(false);
  });

  it('rejects incoherent lifetimes', () => {
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_ACCESS_TTL_SECONDS: '3000000' })).ok).toBe(false); // access >= refresh
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_REFRESH_TTL_SECONDS: '3000000' })).ok).toBe(false); // refresh > absolute
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_IDLE_TTL_SECONDS: '3000000' })).ok).toBe(false); // idle > absolute
    expect(resolveEmailAuthConfig(valid({ CUSTOMER_SESSION_ACCESS_TTL_SECONDS: 'fifteen' })).ok).toBe(false);
  });

  it('requires an https (or localhost) web base URL', () => {
    expect(resolveEmailAuthConfig(valid({ WEB_BASE_URL: 'http://evil.example' })).ok).toBe(false);
    expect(resolveEmailAuthConfig(valid({ WEB_BASE_URL: 'http://localhost:3000' })).ok).toBe(true);
    expect(resolveEmailAuthConfig(valid({ WEB_BASE_URL: 'not a url' })).ok).toBe(false);
  });

  it('derives a domain-separated source key that differs from the secret', async () => {
    const key = await deriveEmailAuthSourceKey(S1);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(S1);
    expect(await deriveEmailAuthSourceKey(S1)).toBe(key);
    expect(await deriveEmailAuthSourceKey(S2)).not.toBe(key);
  });
});
