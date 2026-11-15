import type { PasswordLoginResult } from './customer-password-auth.service';
import { describe, expect, it, vi } from 'vitest';
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
  proof: 'synthetic-proof', password: 'synthetic-password',
};
const loginInput = { email: address, password: completion.password };

function setup() {
  const resolveTrustedSource = vi.fn(async (): Promise<string | null> => 'trusted-edge');
  const limit = vi.fn(async (_input: { key: string; limit: number; windowSeconds: number }) => true);
  const requestProof = vi.fn(async (_email: string) => {});
  const completeRegistration = vi.fn(async () => ({ ok: true, customerId: 'internal-id' }) as const);
  const login = vi.fn(async (): Promise<PasswordLoginResult> => ({ ok: false, kind: 'invalid' }));
  const transportSession = vi.fn(() => new Response(null, { status: 204 }));
  const routes = createIsolatedCustomerEmailAuthRoutes({
    resolveTrustedSource, limit, requestProof, completeRegistration, login, transportSession,
    keyForIdentifier: async () => 'opaque-email',
  });
  return { routes, resolveTrustedSource, limit, requestProof, completeRegistration, login, transportSession };
}

describe('isolated customer email HTTP', () => {
  it('keeps every endpoint unavailable through the disabled router', async () => {
    for (const path of ['register/request', 'register/complete', 'login']) {
      expect((await customerEmailAuthRoutes.request(post(path, loginInput))).status).toBe(404);
    }
  });

  it('normalizes emails and rejects extra fields and missing proofs', () => {
    expect(emailRegistrationRequestSchema.parse({ email: ' SOMEONE@example.com ' }).email).toBe(address);
    expect(emailRegistrationRequestSchema.safeParse({ email: 'bad' }).success).toBe(false);
    expect(emailPasswordLoginSchema.safeParse({ ...loginInput, role: 'staff' }).success).toBe(false);
    expect(emailRegistrationCompleteSchema.safeParse(loginInput).success).toBe(false);
  });

  it('enforces both delivery budgets before sending and hides delivery failures', async () => {
    const { routes, limit, requestProof } = setup();
    requestProof.mockRejectedValueOnce(new Error('internal provider credentials'));
    const response = await routes.request(post('register/request', { email: address }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
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
});
