import { describe, it, expect } from 'vitest';
import {
  CUSTOMER_AUTH_EVENT_METADATA_KEYS,
  sanitizeEventMetadata,
} from './customer-auth-event.repository';

describe('sanitizeEventMetadata (01B: allow-listed keys only, no secrets by construction)', () => {
  it('returns null for nothing or for only undefined values', () => {
    expect(sanitizeEventMetadata(undefined)).toBeNull();
    expect(sanitizeEventMetadata({})).toBeNull();
    expect(sanitizeEventMetadata({ attempt: undefined })).toBeNull();
  });

  it('keeps allow-listed primitives', () => {
    expect(sanitizeEventMetadata({ auth_method: 'otp', attempt: 2, legacy: true })).toEqual({
      auth_method: 'otp',
      attempt: 2,
      legacy: true,
    });
  });

  it.each([
    'token',
    'password',
    'code',
    'phone',
    'user_agent',
    'refresh_token',
    'otp',
    'authorization',
    '__proto__',
  ])('rejects the key %s', (key) => {
    expect(() => sanitizeEventMetadata({ [key]: 'x' } as never)).toThrow(/not allowed/);
  });

  it('rejects non-primitive and oversized values', () => {
    expect(() => sanitizeEventMetadata({ state: { nested: 1 } as never })).toThrow(/primitive/);
    expect(() => sanitizeEventMetadata({ state: ['a'] as never })).toThrow(/primitive/);
    expect(() => sanitizeEventMetadata({ state: null as never })).toThrow(/primitive/);
    expect(() => sanitizeEventMetadata({ state: 'x'.repeat(65) })).toThrow(/too long/);
    expect(sanitizeEventMetadata({ state: 'x'.repeat(64) })).toEqual({ state: 'x'.repeat(64) });
  });

  it('the allow-list contains no key that could carry a secret', () => {
    for (const key of CUSTOMER_AUTH_EVENT_METADATA_KEYS) {
      expect(key).not.toMatch(/token|password|secret|code|phone|otp|agent|auth(orization)?$/);
    }
  });
});
