import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  current: vi.fn(async (): Promise<{ kind: 'legacy' | 'rotating'; accessToken?: string }> => ({ kind: 'legacy' })),
  clear: vi.fn(async () => {}),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/customer-email-auth-client', () => ({
  callCustomerAuthApi: h.api,
  isCustomerEmailAuthWebEnabled: () => process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true',
}));
vi.mock('@/lib/customer-session', () => ({
  getCompatibleCustomerCredentials: h.current,
  clearCompatibleCustomerSession: h.clear,
}));

import { requestCustomerEmailUpgradeAction, completeCustomerEmailUpgradeAction } from './customer-email-upgrade';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [key, value] of Object.entries(fields)) f.set(key, value);
  return f;
};
const email = 'existing@example.test';
const proof = '141664f8-1ef4-4872-b445-fca151ba65aa.synthetic-proof';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
  process.env.CUSTOMER_LEGACY_UPGRADE_ENABLED = 'true';
  delete process.env.CUSTOMER_PASSWORD_MIN_LENGTH;
  h.current.mockResolvedValue({ kind: 'legacy', accessToken: 'legacy-token' });
});

describe('legacy phone-owned customer email/password upgrade', () => {
  it('requires a rotating session, never a legacy 90-day bearer', async () => {
    expect(await requestCustomerEmailUpgradeAction({}, form({ email }))).toEqual({ error: 'verify_phone_again' });
    expect(await completeCustomerEmailUpgradeAction({}, form({
      name: 'Existing Customer', email, challenge: proof, password: 'new-password-123', passwordConfirmation: 'new-password-123',
    }))).toEqual({ error: 'verify_phone_again' });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('never offers credential linking with the email auth feature disabled', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'false';
    expect(await requestCustomerEmailUpgradeAction({}, form({ email }))).toEqual({ error: 'unavailable' });
    expect(h.api).not.toHaveBeenCalled();
  });

  it('requests an email proof only for a real rotating session, with bearer passed server-side', async () => {
    h.current.mockResolvedValue({ kind: 'rotating', accessToken: 'fresh-otp-access' });
    h.api.mockResolvedValue({ status: 202, body: { accepted: true } });
    expect(await requestCustomerEmailUpgradeAction({}, form({ email: ' EXISTING@EXAMPLE.TEST ' }))).toEqual({ sent: true });
    expect(h.api).toHaveBeenCalledExactlyOnceWith('/customer-auth/email/link/request', {
      bearer: 'fresh-otp-access', body: { email },
    });
  });

  it('does not expose a password or session token in action result', async () => {
    h.current.mockResolvedValue({ kind: 'rotating', accessToken: 'fresh-otp-access' });
    h.api.mockResolvedValue({ status: 204, body: null });
    const result = await completeCustomerEmailUpgradeAction({}, form({
      name: 'Existing Customer', email, challenge: proof, password: 'new-password-123', passwordConfirmation: 'new-password-123',
    }));
    expect(result).toEqual({ success: true });
    expect(h.api).toHaveBeenCalledExactlyOnceWith('/customer-auth/email/link/complete', {
      bearer: 'fresh-otp-access',
      body: {
        name: 'Existing Customer', email, challengeId: '141664f8-1ef4-4872-b445-fca151ba65aa',
        proof: 'synthetic-proof', password: 'new-password-123',
      },
    });
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('new-password-123');
    expect(JSON.stringify(result)).not.toContain('fresh-otp-access');
  });

  it('keeps credentials and sessions unchanged after an invalid proof or password mismatch', async () => {
    h.current.mockResolvedValue({ kind: 'rotating', accessToken: 'fresh-otp-access' });
    expect(await completeCustomerEmailUpgradeAction({}, form({
      name: '   ', email, challenge: proof, password: 'new-password-123', passwordConfirmation: 'new-password-123',
    }))).toEqual({ error: 'invalid' });
    expect(await completeCustomerEmailUpgradeAction({}, form({
      name: 'Existing Customer', email, challenge: proof, password: 'password-a', passwordConfirmation: 'password-b',
    }))).toEqual({ error: 'password_mismatch' });
    h.api.mockResolvedValue({ status: 401, body: null });
    expect(await completeCustomerEmailUpgradeAction({}, form({
      name: 'Existing Customer', email, challenge: proof, password: 'new-password-123', passwordConfirmation: 'new-password-123',
    }))).toEqual({ error: 'invalid' });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('maps an expired step-up, identifier throttling and provider failure to safe errors', async () => {
    h.current.mockResolvedValue({ kind: 'rotating', accessToken: 'fresh-otp-access' });
    h.api.mockResolvedValueOnce({ status: 401, body: null })
      .mockResolvedValueOnce({ status: 429, body: null })
      .mockResolvedValueOnce({ status: 503, body: null });
    expect(await requestCustomerEmailUpgradeAction({}, form({ email }))).toEqual({ error: 'verify_phone_again' });
    expect(await requestCustomerEmailUpgradeAction({}, form({ email }))).toEqual({ error: 'rate_limited' });
    expect(await requestCustomerEmailUpgradeAction({}, form({ email }))).toEqual({ error: 'unavailable' });
  });
});
