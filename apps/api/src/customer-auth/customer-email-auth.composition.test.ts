import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createCustomerEmailAuthComposition, customerEmailAuthComposition, type EmailAuthRuntime } from './customer-email-auth.composition';

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const post = (path: string, body: unknown = {}) =>
  new Request(`https://api.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function runtime(over: Partial<EmailAuthRuntime['dependencies']> = {}) {
  const close = vi.fn(async () => {});
  const dependencies = {
    resolveTrustedSource: vi.fn(async () => 'source-key'),
    keyForIdentifier: vi.fn(async () => 'identifier-key'),
    limit: vi.fn(async () => true),
    requestProof: vi.fn(async () => {}),
    completeRegistration: vi.fn(async () => ({ ok: true as const, customerId: 'c1' })),
    login: vi.fn(async () => ({ ok: false as const, kind: 'invalid' as const })),
    transportSession: vi.fn(() => new Response(null, { status: 200 })),
    ...over,
  };
  return { rt: { dependencies, close } as unknown as EmailAuthRuntime, dependencies, close };
}

/** Mounted under /customer-auth exactly like the API does. */
function appWith(options: { enabled: boolean; open: () => Promise<EmailAuthRuntime | null> }) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route('/customer-auth', createCustomerEmailAuthComposition({ isEnabled: () => options.enabled, open: options.open }));
  return app;
}

describe('email auth composition: disabled by default', () => {
  it('answers a generic 404 on every email path and never opens a runtime', async () => {
    const open = vi.fn();
    const app = appWith({ enabled: false, open });
    for (const path of ['/email/register/request', '/email/register/complete', '/email/login']) {
      const response = await app.fetch(post(`/customer-auth${path}`, { email: 'a@example.test' }), {} as Bindings, ctx());
      expect(response.status).toBe(404);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('the mounted instance is off with an empty environment', async () => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.route('/customer-auth', customerEmailAuthComposition);
    for (const flag of [undefined, '', 'TRUE', '1']) {
      const response = await app.fetch(post('/customer-auth/email/login', { email: 'a@example.test', password: 'x' }), { CUSTOMER_EMAIL_AUTH_ENABLED: flag } as unknown as Bindings, ctx());
      expect(response.status).toBe(404);
    }
  });

  it('when ON but a setting is missing, the mounted instance answers 503, never a fallback', async () => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.route('/customer-auth', customerEmailAuthComposition);
    const response = await app.fetch(post('/customer-auth/email/login', { email: 'a@example.test', password: 'x' }), { CUSTOMER_EMAIL_AUTH_ENABLED: 'true' } as unknown as Bindings, ctx());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SECRET|CUSTOMER_/);
  });
});

describe('email auth composition: enabled', () => {
  it('answers a generic 503 when the runtime cannot be built or throws', async () => {
    for (const open of [async () => null, async () => { throw new Error('boom: secret detail'); }]) {
      const response = await appWith({ enabled: true, open }).fetch(post('/customer-auth/email/login', { email: 'a@example.test', password: 'x' }), {} as Bindings, ctx());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('secret detail');
    }
  });

  it('routes through the mount prefix to the isolated handlers and always closes the runtime', async () => {
    const { rt, dependencies, close } = runtime();
    const c = ctx();
    const app = appWith({ enabled: true, open: async () => rt });
    const response = await app.fetch(post('/customer-auth/email/register/request', { email: 'New@Example.Test' }), {} as Bindings, c);
    expect(response.status).toBe(202);
    expect(dependencies.requestProof).toHaveBeenCalledWith('new@example.test');
    expect(c.waitUntil).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('denies a request without a trusted (Web Worker signed) source: no proof is requested', async () => {
    const { rt, dependencies } = runtime({ resolveTrustedSource: vi.fn(async () => null) });
    const response = await appWith({ enabled: true, open: async () => rt }).fetch(post('/customer-auth/email/register/request', { email: 'a@example.test' }), {} as Bindings, ctx());
    expect(response.status).toBe(503);
    expect(dependencies.requestProof).not.toHaveBeenCalled();
  });

  it('is rate limited: a limited identifier gets 429 and no proof is requested', async () => {
    const { rt, dependencies } = runtime({ limit: vi.fn(async () => false) });
    const response = await appWith({ enabled: true, open: async () => rt }).fetch(post('/customer-auth/email/register/request', { email: 'a@example.test' }), {} as Bindings, ctx());
    expect(response.status).toBe(429);
    expect(dependencies.requestProof).not.toHaveBeenCalled();
  });

  it('login failure is one generic 401 and success hands the session to the transport', async () => {
    const failing = runtime();
    const bad = await appWith({ enabled: true, open: async () => failing.rt }).fetch(post('/customer-auth/email/login', { email: 'a@example.test', password: 'whatever' }), {} as Bindings, ctx());
    expect(bad.status).toBe(401);

    const session = { accessToken: 'a' } as never;
    const ok = runtime({
      login: vi.fn(async () => ({ ok: true as const, session })),
      transportSession: vi.fn(() => new Response('{"ok":true}', { status: 200 })),
    });
    const good = await appWith({ enabled: true, open: async () => ok.rt }).fetch(post('/customer-auth/email/login', { email: 'a@example.test', password: 'whatever' }), {} as Bindings, ctx());
    expect(good.status).toBe(200);
    expect(ok.dependencies.transportSession).toHaveBeenCalledWith(session);
  });

  it('exposes no other path under /email', async () => {
    const { rt } = runtime();
    const response = await appWith({ enabled: true, open: async () => rt }).fetch(post('/customer-auth/email/anything-else'), {} as Bindings, ctx());
    expect(response.status).toBe(404);
  });
});
