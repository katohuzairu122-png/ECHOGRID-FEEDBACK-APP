import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn(),
  setRotating: vi.fn(async () => {}),
  revoke: vi.fn(async () => {}),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
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
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const session = { accessToken: 'a', refreshCredential: 'r'.repeat(43), accessExpiresAt: '2026-12-01T00:15:00Z', refreshExpiresAt: '2026-12-31T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
});

describe('email sign-up request', () => {
  it('is unavailable (and calls nothing) when the web flag is off', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = '';
    expect(await requestEmailRegistrationAction({}, form({ email: 'a@example.test' }))).toEqual({ error: 'unavailable' });
    expect(h.api).not.toHaveBeenCalled();
  });
  it('rejects a malformed address before calling the API, and normalizes a good one', async () => {
    expect(await requestEmailRegistrationAction({}, form({ email: 'not-an-email' }))).toEqual({ error: 'invalid_input' });
    h.api.mockResolvedValue({ status: 202, body: { accepted: true } });
    expect(await requestEmailRegistrationAction({}, form({ email: '  New@Example.Test ' }))).toEqual({ sent: true });
    expect(h.api).toHaveBeenCalledWith('/customer-auth/email/register/request', { body: { email: 'new@example.test' } });
  });
  it('maps rate limits and failures to codes without echoing anything from the API', async () => {
    h.api.mockResolvedValue({ status: 429, body: { error: 'Too many requests' } });
    expect(await requestEmailRegistrationAction({}, form({ email: 'a@example.test' }))).toEqual({ error: 'rate_limited' });
    h.api.mockResolvedValue({ status: 503, body: null });
    expect(await requestEmailRegistrationAction({}, form({ email: 'a@example.test' }))).toEqual({ error: 'unavailable' });
    h.api.mockRejectedValue(new Error('network detail'));
    expect(await requestEmailRegistrationAction({}, form({ email: 'a@example.test' }))).toEqual({ error: 'unavailable' });
  });
});

describe('email sign-up completion', () => {
  const good = { email: 'a@example.test', password: 'a long enough password 42', challenge: 'chal-1.proof-1', next: '/loyalty/dashboard' };
  it('completes registration then signs in: cookies set, success returned with a safe next, no credential in the result', async () => {
    h.api.mockResolvedValueOnce({ status: 201, body: { registered: true } }).mockResolvedValueOnce({ status: 200, body: session });
    const result = await completeEmailRegistrationAction({}, form(good));
    expect(result).toEqual({ success: true, next: '/loyalty/dashboard' });
    expect(h.api).toHaveBeenNthCalledWith(1, '/customer-auth/email/register/complete', {
      body: { email: 'a@example.test', challengeId: 'chal-1', proof: 'proof-1', password: good.password },
    });
    expect(h.setRotating).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('r'.repeat(43));
  });
  it('an optional phone is sent only when given, and never as part of the sign-in', async () => {
    h.api.mockResolvedValueOnce({ status: 201, body: {} }).mockResolvedValueOnce({ status: 200, body: session });
    await completeEmailRegistrationAction({}, form({ ...good, phone: ' +965 6690 4591 ' }));
    expect(h.api).toHaveBeenNthCalledWith(1, '/customer-auth/email/register/complete', {
      body: { email: 'a@example.test', challengeId: 'chal-1', proof: 'proof-1', password: good.password, phone: '+965 6690 4591' },
    });
    expect(h.api).toHaveBeenNthCalledWith(2, '/customer-auth/email/login', { body: { email: 'a@example.test', password: good.password } });
    h.api.mockClear();
    h.api.mockResolvedValueOnce({ status: 201, body: {} }).mockResolvedValueOnce({ status: 200, body: session });
    await completeEmailRegistrationAction({}, form({ ...good, phone: '   ' }));
    expect((h.api.mock.calls[0]![1] as { body: Record<string, unknown> }).body).not.toHaveProperty('phone');
  });
  it('a bad proof or weak password is one code and nothing is stored', async () => {
    h.api.mockResolvedValue({ status: 401, body: { error: 'Invalid credentials or proof' } });
    expect(await completeEmailRegistrationAction({}, form(good))).toEqual({ error: 'invalid_proof' });
    expect(h.setRotating).not.toHaveBeenCalled();
  });
  it('refuses incomplete input before any call, and an open-redirect next is neutralised', async () => {
    expect(await completeEmailRegistrationAction({}, form({ ...good, challenge: 'no-dot' }))).toEqual({ error: 'invalid_input' });
    expect(h.api).not.toHaveBeenCalled();
    h.api.mockResolvedValueOnce({ status: 201, body: {} }).mockResolvedValueOnce({ status: 200, body: session });
    expect(await completeEmailRegistrationAction({}, form({ ...good, next: 'https://evil.example/' }))).toEqual({ success: true, next: '/loyalty/dashboard' });
  });
});

describe('email sign-in', () => {
  it('signs in: sets the rotating cookies, returns only success and a safe next', async () => {
    h.api.mockResolvedValue({ status: 200, body: session });
    const result = await loginWithEmailAction({}, form({ email: 'A@Example.test', password: 'pw', next: '/loyalty/dashboard/qr' }));
    expect(result).toEqual({ success: true, next: '/loyalty/dashboard/qr' });
    expect(h.api).toHaveBeenCalledWith('/customer-auth/email/login', { body: { email: 'a@example.test', password: 'pw' } });
    expect(h.setRotating).toHaveBeenCalledTimes(1);
  });
  it('every credential failure is the same code (no account enumeration) and stores nothing', async () => {
    h.api.mockResolvedValue({ status: 401, body: { error: 'Invalid credentials or proof' } });
    expect(await loginWithEmailAction({}, form({ email: 'a@example.test', password: 'wrong' }))).toEqual({ error: 'invalid_credentials' });
    expect(await loginWithEmailAction({}, form({ email: 'bad', password: 'x' }))).toEqual({ error: 'invalid_credentials' });
    expect(await loginWithEmailAction({}, form({ email: 'a@example.test', password: '' }))).toEqual({ error: 'invalid_credentials' });
    expect(h.setRotating).not.toHaveBeenCalled();
  });
  it('a malformed session reply is unavailable and stores nothing', async () => {
    h.api.mockResolvedValue({ status: 200, body: { accessToken: 'only' } });
    expect(await loginWithEmailAction({}, form({ email: 'a@example.test', password: 'pw' }))).toEqual({ error: 'unavailable' });
    expect(h.setRotating).not.toHaveBeenCalled();
  });
  it('is unavailable when the web flag is off', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = '';
    expect(await loginWithEmailAction({}, form({ email: 'a@example.test', password: 'pw' }))).toEqual({ error: 'unavailable' });
    expect(h.api).not.toHaveBeenCalled();
  });
});

describe('ending a session', () => {
  it('revokes, clears, and returns to sign-in', async () => {
    await expect(endRotatingCustomerSessionAction()).rejects.toThrow('REDIRECT:/loyalty/login');
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });
});
