import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  setRotating: vi.fn(async () => {}),
  revoke: vi.fn(async () => {}),
  redirect: vi.fn((to: string) => { throw new Error('REDIRECT:' + to); }),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/lib/customer-email-auth-client', () => ({
  callCustomerAuthApi: h.api,
  isCustomerEmailAuthWebEnabled: () => process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true',
}));
vi.mock('@/lib/customer-session', () => ({ setRotatingCustomerSession: h.setRotating }));
vi.mock('@/lib/customer-session-refresh', () => ({ revokeRotatingCustomerSession: h.revoke }));

import {
  completeEmailRegistrationAction,
  endRotatingCustomerSessionAction,
  loginWithEmailAction,
  requestEmailRegistrationAction,
} from './customer-email-auth';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [key, value] of Object.entries(fields)) f.set(key, value);
  return f;
};
const signup = (fields: Record<string, string> = {}) => form({
  name: 'Synthetic Customer',
  email: 'customer@example.test',
  password: 'strong-registration-password-42',
  passwordConfirmation: 'strong-registration-password-42',
  ...fields,
});
const session = {
  accessToken: 'synthetic-access',
  refreshCredential: 'r'.repeat(43),
  accessExpiresAt: '2026-12-01T00:15:00Z',
  refreshExpiresAt: '2026-12-31T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
  delete process.env.CUSTOMER_PASSWORD_MIN_LENGTH;
});

describe('customer email registration first step', () => {
  it('does not call the API when the feature flag is off', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = '';
    expect(await requestEmailRegistrationAction({}, signup())).toEqual({ error: 'unavailable' });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('validates identity fields and password confirmation before any API call', async () => {
    expect(await requestEmailRegistrationAction({}, signup({ email: 'invalid' }))).toEqual({ error: 'invalid_input' });
    expect(await requestEmailRegistrationAction({}, signup({ name: '' }))).toEqual({ error: 'invalid_input' });
    expect(await requestEmailRegistrationAction({}, signup({ passwordConfirmation: 'wrong' }))).toEqual({ error: 'password_mismatch' });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('submits the signup exactly once through the trusted API, then returns only a generic sent state', async () => {
    h.api.mockResolvedValue({ status: 202, body: { accepted: true } });
    const result = await requestEmailRegistrationAction({}, signup({
      email: '  NEW@EXAMPLE.TEST  ', next: '/loyalty/invite/synthetic-invite',
    }));
    expect(result).toEqual({ sent: true });
    expect(h.api).toHaveBeenCalledExactlyOnceWith('/customer-auth/email/register/request', {
      body: {
        email: 'new@example.test',
        name: 'Synthetic Customer',
        password: 'strong-registration-password-42',
        next: '/loyalty/invite/synthetic-invite',
      },
    });
    expect(JSON.stringify(result)).not.toContain('strong-registration-password-42');
  });

  it('rejects too-short signup passwords before proof issuance using the configured policy', async () => {
    process.env.CUSTOMER_PASSWORD_MIN_LENGTH = '12';
    expect(await requestEmailRegistrationAction({}, signup({ password: 'short', passwordConfirmation: 'short' })))
      .toEqual({ error: 'password_too_short', minLength: 12 });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('maps delivery rate limits and internal failures without exposing secrets', async () => {
    h.api.mockResolvedValueOnce({ status: 429, body: null })
      .mockResolvedValueOnce({ status: 503, body: null })
      .mockRejectedValueOnce(new Error('private provider detail'));
    expect(await requestEmailRegistrationAction({}, signup())).toEqual({ error: 'rate_limited' });
    expect(await requestEmailRegistrationAction({}, signup())).toEqual({ error: 'unavailable' });
    expect(await requestEmailRegistrationAction({}, signup())).toEqual({ error: 'unavailable' });
  });
});

describe('single-use email proof completion', () => {
  const proof = { challenge: 'synthetic-challenge.synthetic-proof', next: '/loyalty/dashboard' };

  it('creates a rotating customer session without re-sending name, email or password', async () => {
    h.api.mockResolvedValue({ status: 201, body: session });
    const result = await completeEmailRegistrationAction({}, form(proof));
    expect(result).toEqual({ success: true, next: '/loyalty/dashboard' });
    expect(h.api).toHaveBeenCalledExactlyOnceWith('/customer-auth/email/register/complete', {
      body: { challengeId: 'synthetic-challenge', proof: 'synthetic-proof' },
    });
    expect(h.setRotating).toHaveBeenCalledExactlyOnceWith(expect.anything());
    expect(JSON.stringify(result)).not.toContain(session.refreshCredential);
  });

  it('preserves a safe QR destination while rejecting an external redirect', async () => {
    h.api.mockResolvedValue({ status: 201, body: session });
    expect(await completeEmailRegistrationAction({}, form({ ...proof, next: 'https://evil.test' })))
      .toEqual({ success: true, next: '/loyalty/dashboard' });
  });

  it('does not create a browser session from malformed or unsuccessful API responses', async () => {
    expect(await completeEmailRegistrationAction({}, form({ challenge: 'missing-dot' })))
      .toEqual({ error: 'invalid_input' });
    h.api.mockResolvedValueOnce({ status: 401, body: { error: 'invalid' } })
      .mockResolvedValueOnce({ status: 201, body: { registered: true } });
    expect(await completeEmailRegistrationAction({}, form(proof))).toEqual({ error: 'invalid_proof' });
    expect(await completeEmailRegistrationAction({}, form(proof))).toEqual({ error: 'unavailable' });
    expect(h.setRotating).not.toHaveBeenCalled();
  });

  it('does not complete registration when the feature is disabled', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'false';
    expect(await completeEmailRegistrationAction({}, form(proof))).toEqual({ error: 'unavailable' });
    expect(h.api).not.toHaveBeenCalled();
  });
});

describe('returning customer password login', () => {
  it('signs in with established email/password without OTP', async () => {
    h.api.mockResolvedValue({ status: 200, body: session });
    const result = await loginWithEmailAction({}, form({
      email: 'NEW@EXAMPLE.TEST', password: 'registered-password', next: '/loyalty/dashboard/qr',
    }));
    expect(result).toEqual({ success: true, next: '/loyalty/dashboard/qr' });
    expect(h.api).toHaveBeenCalledExactlyOnceWith('/customer-auth/email/login', {
      body: { email: 'new@example.test', password: 'registered-password' },
    });
    expect(h.setRotating).toHaveBeenCalledTimes(1);
  });

  it('returns one generic denial for bad credentials and does not store a session', async () => {
    h.api.mockResolvedValue({ status: 401, body: null });
    expect(await loginWithEmailAction({}, form({ email: 'new@example.test', password: 'wrong' })))
      .toEqual({ error: 'invalid_credentials' });
    expect(await loginWithEmailAction({}, form({ email: 'unknown', password: 'x' })))
      .toEqual({ error: 'invalid_credentials' });
    expect(h.setRotating).not.toHaveBeenCalled();
  });

  it('revokes the existing rotating session when signing out', async () => {
    await expect(endRotatingCustomerSessionAction()).rejects.toThrow('REDIRECT:/loyalty/login');
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });
});
