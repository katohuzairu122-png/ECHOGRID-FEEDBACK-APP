import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { AppError } from '../lib/errors';
import {
  CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS,
  CUSTOMER_AUTH_ON_LIMITER_ERROR,
  checkCustomerAuthRateLimit,
  customerAuthRateLimit,
  limiterBindingName,
  readPhoneFromRequest,
  type CustomerAuthSurface,
  type RateLimiterLike,
} from './customer-auth-rate-limit';

/** Behaves like Cloudflare's binding: counts EVERY call per key in a window, success while count <= limit. */
function fixedWindowLimiter(
  limit: number,
  seen: string[] = [],
): RateLimiterLike & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async limit({ key }) {
      seen.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

const PHONE_A = '+15551234567';
const PHONE_B = '+15557654321';
const CUSTOMER = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const SURFACES = Object.keys(CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS) as CustomerAuthSurface[];

/** Every binding present, each with its own limit, recording every key it was asked about. */
function makeEnv(limits: Partial<Record<string, number>> = {}, defaultLimit = 3) {
  const seenKeys: string[] = [];
  const env: Record<string, RateLimiterLike & { counts: Map<string, number> }> = {};
  for (const surface of SURFACES) {
    for (const dim of CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS[surface]) {
      const name = limiterBindingName(surface, dim);
      env[name] = fixedWindowLimiter(limits[name] ?? defaultLimit, seenKeys);
    }
  }
  return { env, seenKeys };
}

describe('configuration', () => {
  it('every surface has its own bindings, so request and verify can never share a budget (finding A4)', () => {
    const names = SURFACES.flatMap((s) =>
      CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS[s].map((d) => limiterBindingName(s, d)),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(limiterBindingName('otp_request', 'phone')).not.toBe(
      limiterBindingName('otp_verify', 'phone'),
    );
    expect(limiterBindingName('otp_request', 'phone')).toBe('CUSTOMER_AUTH_RL_OTP_REQUEST_PHONE');
  });

  it('fails CLOSED on every surface except refresh, whose credential is not guessable', () => {
    for (const s of SURFACES)
      expect(CUSTOMER_AUTH_ON_LIMITER_ERROR[s]).toBe(s === 'session_refresh' ? 'allow' : 'deny');
  });
});

describe('checkCustomerAuthRateLimit', () => {
  it('allows traffic up to the limit and denies the next request', async () => {
    const { env } = makeEnv({}, 3);
    const subject = { phone: PHONE_A, source: '203.0.113.7' };
    for (let i = 0; i < 3; i += 1)
      expect(await checkCustomerAuthRateLimit(env, 'otp_verify', subject)).toEqual({
        allowed: true,
      });
    expect(await checkCustomerAuthRateLimit(env, 'otp_verify', subject)).toMatchObject({
      allowed: false,
      reason: 'limited',
    });
  });

  it('request and verify for the SAME phone have independent budgets', async () => {
    const { env } = makeEnv({}, 2);
    const subject = { phone: PHONE_A, source: '203.0.113.7' };
    for (let i = 0; i < 3; i += 1)
      await checkCustomerAuthRateLimit(env, 'otp_request', { ...subject, source: `10.0.0.${i}` });
    expect(
      await checkCustomerAuthRateLimit(env, 'otp_request', { phone: PHONE_A, source: '10.9.9.9' }),
    ).toMatchObject({ allowed: false, dimension: 'phone' });
    expect(await checkCustomerAuthRateLimit(env, 'otp_verify', subject)).toEqual({ allowed: true });
  });

  it('one phone being throttled does not throttle another phone from a fresh source', async () => {
    const { env } = makeEnv({}, 2);
    for (let i = 0; i < 4; i += 1)
      await checkCustomerAuthRateLimit(env, 'password_login', {
        phone: PHONE_A,
        source: `10.0.0.${i}`,
      });
    expect(
      await checkCustomerAuthRateLimit(env, 'password_login', {
        phone: PHONE_A,
        source: '10.0.1.1',
      }),
    ).toMatchObject({ allowed: false, dimension: 'phone' });
    expect(
      await checkCustomerAuthRateLimit(env, 'password_login', {
        phone: PHONE_B,
        source: '10.0.1.2',
      }),
    ).toEqual({ allowed: true });
  });

  it('the SOURCE dimension stops one source rotating through many phone numbers (SMS cost abuse, T5)', async () => {
    const { env } = makeEnv({}, 3);
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(
        await checkCustomerAuthRateLimit(env, 'otp_request', {
          phone: `+1555000000${i}`,
          source: '198.51.100.9',
        }),
      );
    }
    expect(results.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(results[3]).toMatchObject({ allowed: false, reason: 'limited', dimension: 'source' });
  });

  it('the GLOBAL otp_request ceiling blocks everyone once the platform budget is spent', async () => {
    const { env } = makeEnv({ CUSTOMER_AUTH_RL_OTP_REQUEST_GLOBAL: 2 }, 100);
    expect(
      await checkCustomerAuthRateLimit(env, 'otp_request', { phone: PHONE_A, source: '1.1.1.1' }),
    ).toEqual({ allowed: true });
    expect(
      await checkCustomerAuthRateLimit(env, 'otp_request', { phone: PHONE_B, source: '2.2.2.2' }),
    ).toEqual({ allowed: true });
    expect(
      await checkCustomerAuthRateLimit(env, 'otp_request', {
        phone: '+15559998888',
        source: '3.3.3.3',
      }),
    ).toMatchObject({ allowed: false, dimension: 'global' });
  });

  it('the phone+source dimension limits guessing from one source at one account', async () => {
    const { env } = makeEnv({ CUSTOMER_AUTH_RL_PASSWORD_LOGIN_PHONE_SOURCE: 2 }, 100);
    const s = { phone: PHONE_A, source: '9.9.9.9' };
    await checkCustomerAuthRateLimit(env, 'password_login', s);
    await checkCustomerAuthRateLimit(env, 'password_login', s);
    expect(await checkCustomerAuthRateLimit(env, 'password_login', s)).toMatchObject({
      allowed: false,
      dimension: 'phone_source',
    });
    expect(
      await checkCustomerAuthRateLimit(env, 'password_login', {
        phone: PHONE_A,
        source: '8.8.8.8',
      }),
    ).toEqual({ allowed: true });
  });

  it('password change is limited per customer', async () => {
    const { env } = makeEnv({}, 2);
    const s = { customerId: CUSTOMER };
    await checkCustomerAuthRateLimit(env, 'password_change', s);
    await checkCustomerAuthRateLimit(env, 'password_change', s);
    expect(await checkCustomerAuthRateLimit(env, 'password_change', s)).toMatchObject({
      allowed: false,
      dimension: 'customer',
    });
    expect(
      await checkCustomerAuthRateLimit(env, 'password_change', {
        customerId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({ allowed: true });
  });

  describe('keys', () => {
    it('never contains a phone number, only a hash, and is stable for the same phone', async () => {
      const { env, seenKeys } = makeEnv();
      await checkCustomerAuthRateLimit(env, 'password_login', {
        phone: PHONE_A,
        source: '203.0.113.7',
      });
      await checkCustomerAuthRateLimit(env, 'password_login', {
        phone: PHONE_A,
        source: '203.0.113.8',
      });
      const phoneKeys = seenKeys.filter((k) => k.includes(':phone:'));
      expect(phoneKeys).toHaveLength(2);
      expect(phoneKeys[0]).toBe(phoneKeys[1]);
      for (const key of seenKeys) {
        expect(key).not.toContain('5551234567');
        expect(key).not.toContain(PHONE_A);
      }
      expect(phoneKeys[0]).toMatch(/^ca:password_login:phone:[0-9a-f]{32}$/);
    });

    it('is namespaced per surface and dimension', async () => {
      const { env, seenKeys } = makeEnv();
      await checkCustomerAuthRateLimit(env, 'otp_request', { phone: PHONE_A, source: '1.1.1.1' });
      await checkCustomerAuthRateLimit(env, 'otp_verify', { phone: PHONE_A, source: '1.1.1.1' });
      expect(new Set(seenKeys).size).toBe(seenKeys.length);
    });
  });

  describe('no shared fallback bucket (the "phone:invalid" flaw)', () => {
    it('an invalid or missing phone skips the phone dimension entirely; it never lands in a shared key', async () => {
      const { env, seenKeys } = makeEnv({}, 1);
      for (const phone of [undefined, null, '', 'not-a-phone', 12345, '+0123', '5551234567']) {
        await checkCustomerAuthRateLimit(env, 'otp_verify', { phone, source: null });
      }
      expect(seenKeys).toEqual([]);
      // Garbage from one caller can therefore never exhaust a bucket another caller depends on.
      expect(
        await checkCustomerAuthRateLimit(env, 'otp_verify', { phone: PHONE_A, source: null }),
      ).toEqual({ allowed: true });
    });

    it('a missing or oversized source skips the source dimension; there is no shared "unknown" bucket', async () => {
      const { env, seenKeys } = makeEnv({}, 1);
      for (const source of [undefined, null, '', 'x'.repeat(65)]) {
        await checkCustomerAuthRateLimit(env, 'session_refresh', { source });
      }
      expect(seenKeys).toEqual([]);
    });

    it('trims the phone so whitespace variants share one bucket instead of dodging the limit', async () => {
      const { env } = makeEnv({}, 1);
      await checkCustomerAuthRateLimit(env, 'otp_verify', { phone: PHONE_A, source: null });
      expect(
        await checkCustomerAuthRateLimit(env, 'otp_verify', {
          phone: ` ${PHONE_A} `,
          source: null,
        }),
      ).toMatchObject({ allowed: false, dimension: 'phone' });
    });
  });

  describe('when a limiter is missing or fails', () => {
    it('DENIES a surface that guards a secret or costs money when its binding is absent', async () => {
      for (const surface of SURFACES.filter((s) => s !== 'session_refresh')) {
        const decision = await checkCustomerAuthRateLimit({}, surface, {
          phone: PHONE_A,
          source: '1.1.1.1',
          customerId: CUSTOMER,
        });
        expect(decision).toMatchObject({ allowed: false, reason: 'unavailable' });
      }
    });

    it('DENIES when a limiter throws, on a closed surface', async () => {
      const { env } = makeEnv();
      env[limiterBindingName('password_login', 'source')] = {
        counts: new Map(),
        limit: async () => {
          throw new Error('platform outage');
        },
      };
      expect(
        await checkCustomerAuthRateLimit(env, 'password_login', {
          phone: PHONE_A,
          source: '1.1.1.1',
        }),
      ).toMatchObject({ allowed: false, reason: 'unavailable', dimension: 'source' });
    });

    it('ALLOWS refresh when its limiter is absent or throws, so an outage does not sign everyone out', async () => {
      expect(
        await checkCustomerAuthRateLimit({}, 'session_refresh', { source: '1.1.1.1' }),
      ).toEqual({ allowed: true });
      const broken = {
        [limiterBindingName('session_refresh', 'source')]: {
          limit: async () => {
            throw new Error('down');
          },
        },
      };
      expect(
        await checkCustomerAuthRateLimit(broken, 'session_refresh', { source: '1.1.1.1' }),
      ).toEqual({ allowed: true });
    });

    it('a real "limited" answer still wins over an error on another dimension', async () => {
      const { env } = makeEnv({}, 1);
      env[limiterBindingName('password_login', 'source')] = {
        counts: new Map(),
        limit: async () => {
          throw new Error('down');
        },
      };
      const s = { phone: PHONE_A, source: '1.1.1.1' };
      await checkCustomerAuthRateLimit(env, 'password_login', s);
      expect(await checkCustomerAuthRateLimit(env, 'password_login', s)).toMatchObject({
        allowed: false,
        reason: 'limited',
      });
    });

    it('does not claim a binding that is not a limiter', async () => {
      const decision = await checkCustomerAuthRateLimit(
        { [limiterBindingName('otp_verify', 'phone')]: 'oops' },
        'otp_verify',
        { phone: PHONE_A },
      );
      expect(decision).toMatchObject({ allowed: false, reason: 'unavailable' });
    });
  });

  it('calls EVERY applicable limiter even when an earlier one already denied, so all counters reflect the attempt', async () => {
    const { env } = makeEnv({ CUSTOMER_AUTH_RL_PASSWORD_LOGIN_PHONE: 0 }, 100);
    await checkCustomerAuthRateLimit(env, 'password_login', { phone: PHONE_A, source: '1.1.1.1' });
    for (const dim of ['phone', 'source', 'phone_source'] as const) {
      const limiter = env[limiterBindingName('password_login', dim)]!;
      expect([...limiter.counts.values()].reduce((a, b) => a + b, 0)).toBe(1);
    }
  });
});

describe('readPhoneFromRequest', () => {
  const req = (body: BodyInit, type: string) =>
    new Request('https://api.test/x', { method: 'POST', body, headers: { 'content-type': type } });

  it('reads a phone from JSON and from a form body, and leaves the body readable', async () => {
    const json = req(JSON.stringify({ phone: PHONE_A, code: '123456' }), 'application/json');
    expect(await readPhoneFromRequest(json)).toBe(PHONE_A);
    expect(await json.json()).toEqual({ phone: PHONE_A, code: '123456' });
    const form = req(
      new URLSearchParams({ phone: PHONE_B }).toString(),
      'application/x-www-form-urlencoded',
    );
    expect(await readPhoneFromRequest(form)).toBe(PHONE_B);
    expect(await form.text()).toContain('phone=');
  });

  it('returns null for malformed, empty, non-string and unsupported bodies without throwing', async () => {
    expect(await readPhoneFromRequest(req('{not json', 'application/json'))).toBeNull();
    expect(
      await readPhoneFromRequest(req(JSON.stringify({ phone: 5 }), 'application/json')),
    ).toBeNull();
    expect(await readPhoneFromRequest(req('', 'application/json'))).toBeNull();
    expect(await readPhoneFromRequest(req('phone=+1555', 'text/plain'))).toBeNull();
  });
});

describe('customerAuthRateLimit middleware', () => {
  function appWith(
    surface: CustomerAuthSurface,
    env: Record<string, unknown>,
    decisions: unknown[] = [],
  ) {
    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json({ code: err.code, message: err.message }, err.status)
        : c.json({}, 500),
    );
    app.post(
      '/x',
      customerAuthRateLimit(surface, { onDecision: (s, d) => decisions.push([s, d]) }),
      async (c) => c.json({ ok: true, body: await c.req.json().catch(() => null) }),
    );
    const call = (body: unknown, headers: Record<string, string> = {}) =>
      app.request(
        '/x',
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...headers },
        },
        env,
      );
    return { call };
  }

  it('passes allowed requests through and the handler can still read the body', async () => {
    const { env } = makeEnv();
    const { call } = appWith('otp_verify', env);
    const res = await call(
      { phone: PHONE_A, code: '123456' },
      { 'cf-connecting-ip': '203.0.113.7' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { phone: PHONE_A, code: '123456' } });
  });

  it('answers a limited request with ONE generic 429 that reveals nothing about which dimension tripped', async () => {
    const { env } = makeEnv({}, 1);
    const { call } = appWith('password_login', env);
    await call({ phone: PHONE_A }, { 'cf-connecting-ip': '1.1.1.1' });
    const res = await call({ phone: PHONE_A }, { 'cf-connecting-ip': '1.1.1.1' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please try again shortly.',
    });
    expect(JSON.stringify(body)).not.toMatch(/phone|source|global|customer/i);
  });

  it('answers 503 when a closed surface has no limiter, instead of running unthrottled', async () => {
    const { call } = appWith('password_login', {});
    const res = await call({ phone: PHONE_A }, { 'cf-connecting-ip': '1.1.1.1' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('RATE_LIMIT_UNAVAILABLE');
  });

  it('reports each decision to the hook, without the phone or any key', async () => {
    const { env } = makeEnv();
    const decisions: unknown[] = [];
    const { call } = appWith('otp_verify', env, decisions);
    await call({ phone: PHONE_A }, { 'cf-connecting-ip': '1.1.1.1' });
    expect(decisions).toEqual([['otp_verify', { allowed: true }]]);
    expect(JSON.stringify(decisions)).not.toContain('5551234567');
  });

  it('with no phone and no source it applies no limit rather than a shared one (validation rejects such input anyway)', async () => {
    const { env, seenKeys } = makeEnv({}, 1);
    const { call } = appWith('otp_verify', env);
    for (let i = 0; i < 3; i += 1) expect((await call({ junk: true })).status).toBe(200);
    expect(seenKeys).toEqual([]);
  });
});
