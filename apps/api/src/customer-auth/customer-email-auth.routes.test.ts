import type { PasswordLoginResult } from './customer-password-auth.service';
import { describe, expect, it, vi } from 'vitest';
import { CustomerAuthError } from './customer-auth.service';
import {
  createIsolatedCustomerEmailAuthRoutes,
  customerEmailAuthRoutes,
  emailPasswordLoginSchema,
  emailRegistrationCompleteSchema,
  emailRegistrationRequestSchema,
} from './customer-email-auth.routes';

const address = 'someone@example.com';
const post = (path: string, body: unknown) => new Request(`http://localhost/email/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': 'untrusted' },
  body: JSON.stringify(body),
});
const completion = {
  email: address,
  challengeId: '141664f8-1ef4-4872-b445-fca151ba65aa',
  proof: 'synthetic-proof', name: 'Synthetic Customer', password: 'synthetic-password',
};
const loginInput = { email: address, password: completion.password };

function setup() {
  const resolveTrustedSource = vi.fn(async (): Promise<string | null> => 'trusted-edge');
  const limit = vi.fn(async (_input: { key: string; limit: number; windowSeconds: number }) => true);
  const requestProof = vi.fn(async (_email: string) => {});
  const completeRegistration = vi.fn(async () => ({ ok: true, customerId: 'internal-id' }) as const);
  const login = vi.fn(async (): Promise<PasswordLoginResult> => ({ ok: false, kind: 'invalid' }));
  const changePassword = vi.fn(async () => true);
  const resolvePasswordChangeCustomerId = vi.fn(async (): Promise<string | null> => '11111111-1111-4111-8111-111111111111');
  const transportSession = vi.fn(() => new Response(null, { status: 204 }));
  const routes = createIsolatedCustomerEmailAuthRoutes({
    resolveTrustedSource, limit, requestProof, completeRegistration, login, changePassword,
    resolvePasswordChangeCustomerId, transportSession,
    keyForIdentifier: async () => 'opaque-email',
  });
  return { routes, resolveTrustedSource, limit, requestProof, completeRegistration, login, changePassword, resolvePasswordChangeCustomerId, transportSession };
}

describe('isolated customer email HTTP', () => {
  it('keeps every endpoint unavailable through the disabled router', async () => {
    for (const path of ['register/request', 'register/complete', 'login', 'password/change']) {
      expect((await customerEmailAuthRoutes.request(post(path, loginInput))).status).toBe(404);
    }
  });

  it('normalizes emails and rejects extra fields and missing proofs', () => {
    expect(emailRegistrationRequestSchema.parse({ email: ' SOMEONE@example.com ' }).email).toBe(address);
    expect(emailRegistrationRequestSchema.safeParse({ email: 'bad' }).success).toBe(false);
    expect(emailPasswordLoginSchema.safeParse({ ...loginInput, role: 'staff' }).success).toBe(false);
    expect(emailRegistrationCompleteSchema.safeParse(loginInput).success).toBe(false);
    expect(emailRegistrationRequestSchema.safeParse({ email: address, next: 'https://evil.example' }).success).toBe(false);
    expect(emailRegistrationRequestSchema.safeParse({ email: address, next: '/loyalty/test\n' }).success).toBe(false);
    expect(emailRegistrationRequestSchema.safeParse({ email: address, next: '/loyalty/invite/token' }).success).toBe(true);
  });

  it('enforces both delivery budgets before sending and hides delivery failures', async () => {
    const { routes, limit, requestProof } = setup();
    const eventLog = vi.spyOn(console, 'info').mockImplementation(() => {});
    requestProof.mockRejectedValueOnce(new Error('internal provider credentials'));
    const response = await routes.request(post('register/request', { email: address }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(eventLog).toHaveBeenCalledWith(JSON.stringify({
      event: 'customer_registration_delivery', stage: 'request_failed',
    }));
    expect(eventLog.mock.calls.flat().join(' ')).not.toContain(address);
    expect(eventLog.mock.calls.flat().join(' ')).not.toContain('internal provider credentials');
    eventLog.mockRestore();
    expect(limit.mock.calls.map(([call]) => call)).toEqual([
      { key: 'customer-email:delivery:source:trusted-edge', limit: 10, windowSeconds: 3600 },
      { key: 'customer-email:delivery:identifier:opaque-email', limit: 3, windowSeconds: 3600 },
    ]);
    limit.mockResolvedValueOnce(false);
    expect((await routes.request(post('register/request', { email: address }))).status).toBe(429);
    expect(requestProof).toHaveBeenCalledTimes(1);
  });

  it('fails closed on missing trusted source or a failed limiter', async () => {
    const { routes, resolveTrustedSource, limit, login, completeRegistration } = setup();
    resolveTrustedSource.mockResolvedValueOnce(null);
    expect((await routes.request(post('register/complete', completion))).status).toBe(503);
    limit.mockRejectedValueOnce(new Error('limiter unavailable'));
    expect((await routes.request(post('login', loginInput))).status).toBe(503);
    expect(completeRegistration).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('hands successful login to customer session transport with no credential fields in the response body', async () => {
    const { routes, login, transportSession } = setup();
    const now = new Date();
    const session = {
      customerId: 'synthetic-customer', sessionId: 'synthetic-session',
      accessToken: 'synthetic-access', accessExpiresAt: now,
      refreshCredential: 'synthetic-refresh', refreshExpiresAt: now,
      sessionAbsoluteExpiresAt: now,
    };
    login.mockResolvedValueOnce({ ok: true, session });
    const response = await routes.request(post('login', loginInput));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(transportSession).toHaveBeenCalledExactlyOnceWith(session);
  });

  it('returns no customer ID from completion and no session from invalid login', async () => {
    const { routes, limit, transportSession } = setup();
    const completed = await routes.request(post('register/complete', completion));
    expect(completed.status).toBe(201);
    expect(await completed.json()).toEqual({ registered: true });
    const rejected = await routes.request(post('login', loginInput));
    expect(rejected.status).toBe(401);
    expect(limit.mock.calls.map(([call]) => [call.limit, call.windowSeconds])).toEqual([[5, 900], [5, 900]]);
    expect(transportSession).not.toHaveBeenCalled();
  });

  it('changes a password only through a trusted, rate-limited request with a rotating-session bearer', async () => {
    const { routes, changePassword, limit } = setup();
    const req = new Request('http://localhost/email/password/change', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer rotating-access' },
      body: JSON.stringify({ currentPassword: 'current-secret', newPassword: 'next-secret' }),
    });
    const response = await routes.request(req);
    expect(response.status).toBe(204);
    expect(changePassword).toHaveBeenCalledExactlyOnceWith('rotating-access', {
      currentPassword: 'current-secret', newPassword: 'next-secret',
    });
    expect(limit.mock.calls).toHaveLength(3);
    expect(limit.mock.calls.map(([call]) => call.key)).toEqual([
      'customer-email:login:source:trusted-edge',
      'customer-email:login:identifier:opaque-email',
      'customer-email:login:account:opaque-email',
    ]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed when a request has no live rotating customer identity for the account budget', async () => {
    const state = setup();
    state.resolvePasswordChangeCustomerId.mockResolvedValueOnce(null);
    const req = new Request('http://localhost/email/password/change', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer stale-token' },
      body: JSON.stringify({ currentPassword: 'current-secret', newPassword: 'next-secret' }),
    });
    expect((await state.routes.request(req)).status).toBe(401);
    expect(state.limit).not.toHaveBeenCalled();
    expect(state.changePassword).not.toHaveBeenCalled();
  });

  it('does not run a password change without trusted source or an access bearer', async () => {
    const first = setup();
    first.resolveTrustedSource.mockResolvedValueOnce(null);
    expect((await first.routes.request(new Request('http://localhost/email/password/change', { method: 'POST' }))).status).toBe(503);
    expect(first.changePassword).not.toHaveBeenCalled();
    const second = setup();
    const response = await second.routes.request(post('password/change', {
      currentPassword: 'current-secret', newPassword: 'next-secret',
    }));
    expect(response.status).toBe(401);
    expect(second.changePassword).not.toHaveBeenCalled();
  });
});


describe('legacy phone OTP upgrade HTTP boundaries', () => {
  const phone = '+15551234567';
  const code = '123456';
  const address = 'legacy-upgrade@example.test';
  const source = async () => 'trusted-edge';
  const budget = async () => true;
  const make = (over: Record<string, unknown> = {}) => {
    const legacyOtpSession = vi.fn(async () => ({
      customerId: 'existing-customer', sessionId: 'session-1',
      accessToken: 'access', accessExpiresAt: new Date(),
      refreshCredential: 'r'.repeat(43), refreshExpiresAt: new Date(),
      sessionAbsoluteExpiresAt: new Date(),
    }));
    const requestLink = vi.fn(async () => true);
    const completeLink = vi.fn(async () => true);
    const transportSession = vi.fn(() => Response.json({ accessToken: 'synthetic-access' }, { status: 200 }));
    const router = createIsolatedCustomerEmailAuthRoutes({
      resolveTrustedSource: source,
      keyForIdentifier: async () => 'digest',
      limit: budget,
      requestProof: async () => {},
      completeRegistration: async () => ({ ok: false as const, kind: 'invalid' as const }),
      login: async () => ({ ok: false as const, kind: 'invalid' as const }),
      changePassword: async () => false,
      resolvePasswordChangeCustomerId: async () => '11111111-1111-4111-8111-111111111111',
      legacyOtpSession,
      requestLink,
      completeLink,
      transportSession,
      ...over,
    });
    return { router, legacyOtpSession, requestLink, completeLink, transportSession };
  };
  const request = (path: string, body: unknown, bearer?: string) => new Request('http://localhost/email/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify(body),
  });

  it('cannot issue legacy upgrade sessions when the route is flag-off', async () => {
    expect((await customerEmailAuthRoutes.request(request('legacy/otp-login', { phone, code }))).status).toBe(404);
    expect((await customerEmailAuthRoutes.request(request('link/request', { email: address }))).status).toBe(404);
    expect((await customerEmailAuthRoutes.request(request('link/complete', {
      email: address, challengeId: completion.challengeId, proof: completion.proof, password: completion.password,
    }))).status).toBe(404);
  });

  it('uses only the server-verified phone proof for a rotating OTP session', async () => {
    const { router, legacyOtpSession, transportSession } = make();
    const response = await router.request(request('legacy/otp-login', { phone, code }));
    expect(response.status).toBe(200);
    expect(legacyOtpSession).toHaveBeenCalledExactlyOnceWith(phone, code);
    expect(transportSession).toHaveBeenCalledTimes(1);
    expect((await router.request(request('legacy/otp-login', { phone: '15551234567', code }))).status).toBe(400);
    expect(legacyOtpSession).toHaveBeenCalledTimes(1);
  });

  it('does not transport or issue a session when upgrade identity resolution denies', async () => {
    const resolver = vi.fn(async () => null);
    const { router, transportSession } = make({ legacyOtpSession: resolver });
    const response = await router.request(request('legacy/otp-login', { phone, code }));

    expect(response.status).toBe(401);
    expect(transportSession).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledExactlyOnceWith(phone, code);
  });

  it('maps expected OTP identity denial to the generic authentication response', async () => {
    const resolver = vi.fn(async () => { throw new CustomerAuthError('Code is invalid or has expired.', 'OTP_INVALID'); });
    const { router, transportSession } = make({ legacyOtpSession: resolver });
    const response = await router.request(request('legacy/otp-login', { phone, code }));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(JSON.stringify({ error: 'Invalid credentials or proof' }));
    expect(transportSession).not.toHaveBeenCalled();
  });

  it('sanitizes operational upgrade errors and does not issue a session', async () => {
    const secretDetail = 'synthetic SQL connection detail';
    const resolver = vi.fn(async () => { throw new Error(secretDetail); });
    const { router, transportSession } = make({ legacyOtpSession: resolver });
    const response = await router.request(request('legacy/otp-login', { phone, code }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(secretDetail);
    expect(transportSession).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledExactlyOnceWith(phone, code);
  });

  it('rejects untrusted sources before phone or link service execution', async () => {
    const { router, legacyOtpSession, requestLink, completeLink } = make({
      resolveTrustedSource: async () => null,
    });
    expect((await router.request(request('legacy/otp-login', { phone, code }))).status).toBe(503);
    expect((await router.request(request('link/request', { email: address }, 'otp-access'))).status).toBe(503);
    expect((await router.request(request('link/complete', {
      email: address, challengeId: completion.challengeId, proof: completion.proof, password: completion.password,
    }, 'otp-access'))).status).toBe(503);
    expect(legacyOtpSession).not.toHaveBeenCalled();
    expect(requestLink).not.toHaveBeenCalled();
    expect(completeLink).not.toHaveBeenCalled();
  });

  it('requires an authenticated rotating bearer for both link operations', async () => {
    const { router, requestLink, completeLink } = make();
    expect((await router.request(request('link/request', { email: address }))).status).toBe(401);
    expect((await router.request(request('link/complete', {
      email: address, challengeId: completion.challengeId, proof: completion.proof, password: completion.password,
    }))).status).toBe(401);
    expect(requestLink).not.toHaveBeenCalled();
    expect(completeLink).not.toHaveBeenCalled();
  });

  it('keeps the proof request generic and authorizes completion through the injected identity service', async () => {
    const { router, requestLink, completeLink } = make();
    expect((await router.request(request('link/request', { email: address }, 'otp-access'))).status).toBe(202);
    expect(requestLink).toHaveBeenCalledExactlyOnceWith('otp-access', address);
    const input = { email: address, challengeId: completion.challengeId, proof: completion.proof, password: completion.password };
    expect((await router.request(request('link/complete', input, 'otp-access'))).status).toBe(204);
    expect(completeLink).toHaveBeenCalledExactlyOnceWith('otp-access', input);
  });

  it('never grants an upgrade when the security service denies it', async () => {
    const { router, completeLink } = make({ requestLink: async () => false, completeLink: async () => false });
    expect((await router.request(request('link/request', { email: address }, 'old-bearer'))).status).toBe(401);
    expect((await router.request(request('link/complete', {
      email: address, challengeId: completion.challengeId, proof: completion.proof, password: completion.password,
    }, 'old-bearer'))).status).toBe(401);
    expect(completeLink).not.toHaveBeenCalled();
  });
});
