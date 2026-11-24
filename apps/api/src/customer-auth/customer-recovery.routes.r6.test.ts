import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createCustomerRecoveryRoutes,
  type CustomerRecoveryRouteDependencies,
} from './customer-recovery.routes';

/**
 * CUSTOMER-AUTH-R6: database-free route-boundary regressions.
 *
 * These tests deliberately do not exercise or enable the real recovery composition.
 * End-to-end recovery, delivery, factor policy and session revocation remain subject
 * to separate disposable PostgreSQL and browser acceptance evidence.
 */
const CUSTOMER_ID = 'a114c838-35fb-4ce4-899f-5e3c644027f5';

function fixture(
  options: {
    enabled?: boolean;
    trusted?: boolean;
    reauthenticated?: boolean;
    limited?: boolean;
  } = {},
) {
  const findCustomerIdByLoginEmail = vi.fn(async (email: string) =>
    email === 'known@example.test' ? CUSTOMER_ID : null,
  );
  const findCustomerIdByVerifiedPhone = vi.fn(async (phone: string) =>
    phone === '+15555550101' ? CUSTOMER_ID : null,
  );
  const initiate = vi.fn(async () => ({
    ok: true as const,
    attemptId: crypto.randomUUID(),
  }));
  const codeManagement = {
    authenticate: vi.fn(async (token: string) =>
      token === 'valid-session'
        ? {
            assurance: 'session' as const,
            customerId: CUSTOMER_ID,
            sessionId: crypto.randomUUID(),
            authMethod: 'password',
          }
        : null,
    ),
    reauthenticate: vi.fn(async () => options.reauthenticated !== false),
    allow: vi.fn(async () => options.limited !== true),
    issue: vi.fn(async () => ({ ok: true as const, codes: ['AAAA-BBBB-CCCC-DDDD'] })),
    revoke: vi.fn(async () => ({ ok: true as const, revoked: true })),
  };
  const dependencies = {
    findCustomerIdByLoginEmail,
    findCustomerIdByVerifiedPhone,
    service: { initiate },
    codeManagement,
  } as unknown as CustomerRecoveryRouteDependencies;
  const resolveTrustedSource = vi.fn(async () =>
    options.trusted === false ? null : 'r6-test-trusted-source',
  );
  const open = vi.fn(async () => ({ deps: dependencies, close: async () => {} }));
  const routes = createCustomerRecoveryRoutes({
    isEnabled: () => options.enabled !== false,
    resolveTrustedSource,
    open,
  });
  const app = new Hono();
  app.route('/recovery', routes);
  const post = (path: string, body: unknown, authorization?: string) =>
    app.request('/recovery/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
  return {
    app,
    post,
    open,
    initiate,
    resolveTrustedSource,
    findCustomerIdByLoginEmail,
    findCustomerIdByVerifiedPhone,
    codeManagement,
  };
}

describe('CUSTOMER-AUTH-R6 recovery HTTP containment', () => {
  it('returns generic 404 on every recovery operation when disabled, before resolving trust or opening a database', async () => {
    const f = fixture({ enabled: false });
    for (const path of [
      'initiate',
      'email-challenge',
      'email-verify',
      'phone-otp',
      'phone-verify',
      'code-verify',
      'cancel',
      'complete',
      'codes/issue',
      'codes/revoke',
    ]) {
      const response = await f.post(path, { email: 'known@example.test' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.resolveTrustedSource).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.initiate).not.toHaveBeenCalled();
  });

  it('fails closed for untrusted callers without opening dependencies', async () => {
    const f = fixture({ trusted: false });
    const response = await f.post('initiate', { email: 'known@example.test' });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.open).not.toHaveBeenCalled();
    expect(f.initiate).not.toHaveBeenCalled();
  });

  it('rejects unsolicited account selectors before opening dependencies', async () => {
    const f = fixture();
    for (const payload of [
      { email: 'known@example.test', phone: '+15555550100' },
      { email: 'known@example.test', proof: 'client-forged-proof' },
      { email: 'not-an-email' },
    ]) {
      const response = await f.post('initiate', payload);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.open).not.toHaveBeenCalled();
    expect(f.initiate).not.toHaveBeenCalled();
  });

  it('keeps known and unknown account initiation responses generic and without cookies', async () => {
    const f = fixture();
    for (const selector of [
      { email: 'known@example.test' },
      { email: 'unknown@example.test' },
      { phone: '+15555550101' },
      { phone: '+15555550102' },
    ]) {
      const response = await f.post('initiate', selector);
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['attemptId']);
      expect(body.attemptId).toEqual(expect.any(String));
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    expect(f.findCustomerIdByLoginEmail).toHaveBeenCalledTimes(2);
    expect(f.findCustomerIdByVerifiedPhone).toHaveBeenCalledTimes(2);
    expect(f.initiate).toHaveBeenCalledTimes(4);
  });

  it('requires a valid password session and fresh password reauthentication before issuing recovery codes', async () => {
    const f = fixture({ reauthenticated: false });
    const noSession = await f.post('codes/issue', { currentPassword: 'synthetic-password' });
    expect(noSession.status).toBe(401);
    const badPassword = await f.post(
      'codes/issue',
      { currentPassword: 'incorrect' },
      'Bearer valid-session',
    );
    expect(badPassword.status).toBe(401);
    expect(f.codeManagement.issue).not.toHaveBeenCalled();
    expect(f.codeManagement.authenticate).toHaveBeenCalledTimes(1);
  });

  it('rate limits code management and returns a new code set only after reauthentication', async () => {
    const limited = fixture({ limited: true });
    expect(
      (
        await limited.post(
          'codes/issue',
          { currentPassword: 'synthetic-password' },
          'Bearer valid-session',
        )
      ).status,
    ).toBe(401);
    expect(limited.codeManagement.reauthenticate).not.toHaveBeenCalled();
    const f = fixture();
    const response = await f.post(
      'codes/issue',
      { currentPassword: 'synthetic-password' },
      'Bearer valid-session',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ codes: ['AAAA-BBBB-CCCC-DDDD'] });
    expect(f.codeManagement.reauthenticate).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER_ID, currentPassword: 'synthetic-password' }),
    );
    expect(f.codeManagement.issue).toHaveBeenCalledTimes(1);
  });
});
