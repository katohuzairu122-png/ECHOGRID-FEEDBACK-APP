import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createCustomerSessionLifecycleComposition, customerSessionLifecycleComposition, type SessionLifecycleRuntime } from './customer-session-lifecycle.composition';

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const CREDENTIAL = 'A'.repeat(43);
const post = (path: string, credential: string | null = CREDENTIAL) =>
  new Request(`https://api.test/customer-session${path}`, { method: 'POST', headers: credential ? { authorization: `Bearer ${credential}` } : {} });

function runtime(over: Partial<SessionLifecycleRuntime> = {}) {
  const close = vi.fn(async () => {});
  const sessions = {
    refresh: vi.fn(async () => ({ ok: true as const, session: { accessToken: 'a', accessExpiresAt: new Date(0), refreshCredential: 'r', refreshExpiresAt: new Date(0) } })),
    authenticateSessionToken: vi.fn(async () => ({ assurance: 'session' as const, customerId: 'c', sessionId: 's' })),
    revokeSession: vi.fn(async () => true),
  };
  return { rt: { sessions, resolveTrustedSource: vi.fn(async () => 'trusted'), close, ...over } as unknown as SessionLifecycleRuntime, sessions, close };
}
const appWith = (enabled: boolean, open: () => Promise<SessionLifecycleRuntime | null>) => {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route('/customer-session', createCustomerSessionLifecycleComposition({ isEnabled: () => enabled, open }));
  return app;
};

describe('session lifecycle composition (S5-03)', () => {
  it('flag off: a generic 404, nothing opened', async () => {
    const open = vi.fn();
    for (const path of ['/refresh', '/logout']) expect((await appWith(false, open).fetch(post(path), {} as Bindings, ctx())).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it('the mounted instance is off by default and 503 when on but unconfigured', async () => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.route('/customer-session', customerSessionLifecycleComposition);
    expect((await app.fetch(post('/refresh'), {} as Bindings, ctx())).status).toBe(404);
    const response = await app.fetch(post('/refresh'), { CUSTOMER_EMAIL_AUTH_ENABLED: 'true' } as unknown as Bindings, ctx());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SECRET|CUSTOMER_/);
  });

  it('503 when the runtime cannot be built or throws', async () => {
    for (const open of [async () => null, async () => { throw new Error('secret detail'); }]) {
      const response = await appWith(true, open).fetch(post('/refresh'), {} as Bindings, ctx());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('secret detail');
    }
  });

  it('refuses a request without the Web Worker signature, so a browser cannot present a credential directly', async () => {
    const { rt, sessions, close } = runtime({ resolveTrustedSource: vi.fn(async () => null) });
    const response = await appWith(true, async () => rt).fetch(post('/refresh'), {} as Bindings, ctx());
    expect(response.status).toBe(401);
    expect(sessions.refresh).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('routes refresh and logout through the mount prefix and closes the runtime', async () => {
    const { rt, sessions, close } = runtime();
    const app = appWith(true, async () => rt);
    const refreshed = await app.fetch(post('/refresh'), {} as Bindings, ctx());
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get('cache-control')).toBe('no-store');
    expect(sessions.refresh).toHaveBeenCalledWith(CREDENTIAL);
    const out = await app.fetch(post('/logout'), {} as Bindings, ctx());
    expect(out.status).toBe(204);
    expect(sessions.revokeSession).toHaveBeenCalledWith({ customerId: 'c', sessionId: 's' });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('a malformed credential is one generic 401 and exposes no other path', async () => {
    const { rt, sessions } = runtime();
    const app = appWith(true, async () => rt);
    expect((await app.fetch(post('/refresh', 'short'), {} as Bindings, ctx())).status).toBe(401);
    expect(sessions.refresh).not.toHaveBeenCalled();
    expect((await app.fetch(post('/anything-else'), {} as Bindings, ctx())).status).toBe(404);
  });
});
