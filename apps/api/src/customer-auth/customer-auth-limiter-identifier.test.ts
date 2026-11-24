import { describe, expect, it, vi } from 'vitest';
import { createEmailAuthDependencies } from './customer-email-auth.composition';
import { customerAuthLimiterIdentifier } from './customer-auth-limiter-identifier';
import { customerChallengeDigest } from './customer-email-challenge-digest';
import { createIsolatedCustomerEmailAuthRoutes } from './customer-email-auth.routes';

const secret = 'synthetic-limiter-secret-with-at-least-32-bytes';
const customerId = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const limit = vi.fn(async () => true);
  const legacyOtpSession = vi.fn(async () => ({ accessToken: 'synthetic' }) as never);
  const dependencies = createEmailAuthDependencies({
    hmacSecret: secret, passwordMinLength: 8, webBaseUrl: 'http://localhost:3000',
    session: {} as never,
  }, {
    withDb: async () => { throw new Error('No database should be opened'); },
    hasher: {} as never, limit, resolveTrustedSource: async () => 'trusted-source', legacyOtpSession,
  });
  const changePassword = vi.fn(async () => true);
  const app = createIsolatedCustomerEmailAuthRoutes({
    ...dependencies, changePassword, resolvePasswordChangeCustomerId: async () => customerId,
    transportSession: () => new Response(null, { status: 200 }),
  });
  const post = (path: string, body: unknown) => app.request(`/email/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic' },
    body: JSON.stringify(body),
  });
  return { limit, legacyOtpSession, changePassword, post };
}

describe('real customer-auth limiter key composition', () => {
  it('preserves existing email budget keys and keeps challenge subjects email-only', async () => {
    expect(await customerAuthLimiterIdentifier(secret, 'a@example.test')).toBe(
      await customerChallengeDigest({ secret, purpose: 'email_registration', field: 'subject', value: 'a@example.test' }),
    );
    await expect(customerChallengeDigest({ secret, purpose: 'email_registration', field: 'subject', value: '+15551234567' })).rejects.toThrow();
  });

  it('produces opaque, distinct phone and credential-change keys; invalid values fail closed', async () => {
    const subjects = ['+15551234567', '+15551234568', 'password-change', `password-change:${customerId}`];
    const keys = await Promise.all(subjects.map(value => customerAuthLimiterIdentifier(secret, value)));
    expect(new Set(keys).size).toBe(subjects.length);
    for (let i = 0; i < keys.length; i++) {
      expect(keys[i]).toMatch(/^[a-f0-9]{64}$/);
      expect(keys[i]).toBe(await customerAuthLimiterIdentifier(secret, subjects[i]!));
      expect(keys[i]).not.toBe(await customerAuthLimiterIdentifier(secret + '-other', subjects[i]!));
    }
    for (const value of ['', 'password-change:not-a-uuid', '+not-a-phone', ' A@EXAMPLE.TEST ']) {
      await expect(customerAuthLimiterIdentifier(secret, value)).rejects.toThrow();
    }
    await expect(customerAuthLimiterIdentifier('short', '+15551234567')).rejects.toThrow();
  });

  it('allows verified legacy OTP to reach its service with actual keyed source and identifier limits', async () => {
    const f = fixture();
    expect((await f.post('legacy/otp-login', { phone: '+15551234567', code: '123456' })).status).toBe(200);
    expect(f.legacyOtpSession).toHaveBeenCalledWith('+15551234567', '123456');
    expect(f.limit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.limit.mock.calls)).not.toContain('+15551234567');
  });

  it('denies throttled OTP without checking provider proof or creating a session', async () => {
    const f = fixture(); f.limit.mockResolvedValue(false);
    expect((await f.post('legacy/otp-login', { phone: '+15551234567', code: '123456' })).status).toBe(429);
    expect(f.legacyOtpSession).not.toHaveBeenCalled();
  });

  it('uses all three unchanged credential-change budgets with actual HMAC keys', async () => {
    const f = fixture();
    expect((await f.post('password/change', { currentPassword: 'old-password', newPassword: 'new-password' })).status).toBe(204);
    expect(f.limit).toHaveBeenCalledTimes(3);
    expect(f.changePassword).toHaveBeenCalledOnce();
    expect(f.limit.mock.calls.map(call => JSON.stringify(call)).join(' ')).not.toContain(customerId);
  });

  it('denies an exhausted per-account budget before any password change', async () => {
    const f = fixture();
    f.limit.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await f.post('password/change', { currentPassword: 'old-password', newPassword: 'new-password' })).status).toBe(429);
    expect(f.limit).toHaveBeenCalledTimes(3);
    expect(f.changePassword).not.toHaveBeenCalled();
  });
});
