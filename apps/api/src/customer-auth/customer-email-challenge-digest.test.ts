import { describe, expect, it } from 'vitest';
import {
  customerChallengeDigest,
  normalizeLoginEmail,
} from './customer-email-challenge-digest';

const secret = 'a-dedicated-test-secret-with-at-least-thirty-two-bytes';

describe('S2 keyed challenge digests (unmounted)', () => {
  it('normalizes email consistently and refuses malformed subjects', () => {
    expect(normalizeLoginEmail('  USER@Example.COM  ')).toBe('user@example.com');
    expect(normalizeLoginEmail('not-an-email')).toBeNull();
    expect(normalizeLoginEmail('a@b')).toBeNull();
    expect(normalizeLoginEmail(null)).toBeNull();
  });

  it('is deterministic, hex encoded and purpose/field separated', async () => {
    const input = { secret, purpose: 'email_registration' as const, field: 'subject' as const, value: 'user@example.com' };
    const a = await customerChallengeDigest(input);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(await customerChallengeDigest(input)).toBe(a);
    expect(await customerChallengeDigest({ ...input, purpose: 'email_recovery' })).not.toBe(a);
    expect(await customerChallengeDigest({ secret, purpose: 'email_registration', field: 'proof', value: 'user@example.com' })).not.toBe(a);
  });

  it('rejects missing/weak keys and unnormalized email', async () => {
    await expect(customerChallengeDigest({ secret: '', purpose: 'email_registration', field: 'subject', value: 'user@example.com' })).rejects.toThrow();
    await expect(customerChallengeDigest({ secret, purpose: 'email_registration', field: 'subject', value: 'User@example.com' })).rejects.toThrow();
    await expect(customerChallengeDigest({ secret, purpose: 'email_registration', field: 'proof', value: '123' })).rejects.toThrow();
  });
});
