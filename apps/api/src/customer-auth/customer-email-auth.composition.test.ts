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
    changePassword: vi.fn(async () => true),
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

describe('email auth composition and the password policy (CUSTOMER-EMAIL-AUTH-POLICY-01)', () => {
  const fullEnv = (over: Record<string, unknown> = {}) => ({
    CUSTOMER_EMAIL_AUTH_ENABLED: 'true',
    CUSTOMER_EMAIL_AUTH_HMAC_SECRET: 'a'.repeat(40),
    CUSTOMER_SESSION_SIGNING_SECRET: 'b'.repeat(40),
    CUSTOMER_SESSION_ACCESS_TTL_SECONDS: '900',
    CUSTOMER_SESSION_REFRESH_TTL_SECONDS: '2592000',
    CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
    CUSTOMER_SESSION_IDLE_TTL_SECONDS: '1209600',
    CUSTOMER_STEP_UP_WINDOW_SECONDS: '300',
    CUSTOMER_PASSWORD_MIN_LENGTH: '8',
    CUSTOMER_JWT_SECRET: 'legacy-customer-jwt-secret-value-0123456789',
    CLIENT_ATTRIBUTION_SECRET: 'attribution-secret-value-0123456789abcdef',
    WEB_BASE_URL: 'https://app.example.test',
    HYPERDRIVE: {}, PASSWORD_HASHER: {}, CUSTOMER_AUTH_RATE_LIMIT: {},
    ...over,
  }) as unknown as Bindings;
  const mounted = () => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.route('/customer-auth', customerEmailAuthComposition);
    return app;
  };

  it('setting the password minimum does not activate the feature: with the flag off every path is a generic 404', async () => {
    for (const flag of [undefined, 'false', '']) {
      for (const path of ['/email/register/request', '/email/register/complete', '/email/login']) {
        const response = await mounted().fetch(post(`/customer-auth${path}`, {}), fullEnv({ CUSTOMER_EMAIL_AUTH_ENABLED: flag }), ctx());
        expect(response.status, `${flag} ${path}`).toBe(404);
      }
    }
  });

  it('with the flag on but the minimum missing, the feature fails closed (503) rather than adopting a default', async () => {
    for (const path of ['/email/register/request', '/email/register/complete', '/email/login']) {
      const response = await mounted().fetch(post(`/customer-auth${path}`, {}), fullEnv({ CUSTOMER_PASSWORD_MIN_LENGTH: undefined }), ctx());
      expect(response.status, path).toBe(503);
      expect(await response.text()).not.toMatch(/MIN_LENGTH|SECRET/);
    }
  });

  it('authentication rate limits do not depend on the password: a limited sign-in is refused (429) for a 7-character and a 40-character password alike', async () => {
    for (const password of ['rBq4nZx', 'x'.repeat(40)]) {
      const { rt, dependencies } = runtime({ limit: vi.fn(async () => false) });
      const response = await appWith({ enabled: true, open: async () => rt }).fetch(
        post('/customer-auth/email/login', { email: 'a@example.test', password }), {} as Bindings, ctx(),
      );
      expect(response.status).toBe(429);
      expect(dependencies.login).not.toHaveBeenCalled();
    }
  });

  it('sign-in is rate limited per source and per address on every attempt, whatever the password length', async () => {
    const { rt, dependencies } = runtime();
    const app = appWith({ enabled: true, open: async () => rt });
    for (const password of ['rBq4nZx', 'rBq4nZxk', 'x'.repeat(100)]) {
      await app.fetch(post('/customer-auth/email/login', { email: 'a@example.test', password }), {} as Bindings, ctx());
    }
    // two budgets (source + identifier) are spent for each of the three attempts
    expect((dependencies.limit as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);
  });
});

