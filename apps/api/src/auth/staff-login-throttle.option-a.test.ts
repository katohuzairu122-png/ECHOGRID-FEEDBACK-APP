import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { resolveClient, signClientAttribution } from '../lib/client-attribution';

/**
 * STG-SEC-02B: staff login throttling, design option A (docs/STAFF-LOGIN-THROTTLING-DESIGN.md). Runs the REAL `/auth/login`
 * route and the REAL limiter against counting limiters with production settings (AUTH 10/60 s, API floor 300/60 s). Only the
 * account service, database and password hasher are replaced.
 *
 * The characterization suite (staff-login-throttle.adversarial.test.ts) pins the secret-UNSET behaviour, which must not change.
 * This suite proves the secret-SET behaviour: the four KNOWN WEAKNESSES no longer apply to signed web traffic.
 */
const m = vi.hoisted(() => ({ login: vi.fn(), authKeys: [] as string[] }));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => undefined })) }));
vi.mock('../repositories', () => ({ createRepositories: () => ({}) }));
vi.mock('./pbkdf2-worker', () => ({ createDurableObjectPbkdf2Worker: () => ({}) }));
vi.mock('./auth.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth.service')>();
  return { ...actual, AuthService: class { login = m.login; } };
});

const { authRoutes } = await import('./auth.routes');
const { errorHandler } = await import('../lib/error-handler');
const { AuthError } = await import('./auth.service');

const SECRET = 'staff-attribution-secret-for-tests';
const OLD = 'previous-attribution-secret-for-tests';
const EGRESS = '198.51.100.250'; // the web Worker's address as the API sees it

/** Atomic counting limiter (the Cloudflare binding counts atomically); optional jitter to interleave concurrent callers. */
function limiter(limit: number, record?: string[], jitter = false) {
  const hits = new Map<string, number>();
  return {
    hits,
    limit: async ({ key }: { key: string }) => {
      if (jitter) await new Promise((r) => setTimeout(r, Math.random() * 3));
      record?.push(key);
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}
type Env = { secret?: string; previous?: string; floor?: number; jitter?: boolean };
function rig(opts: Env = { secret: SECRET }) {
  const auth = limiter(10, m.authKeys, opts.jitter);
  const floor = limiter(opts.floor ?? 300, undefined, opts.jitter);
  const env = {
    JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'r', HYPERDRIVE: { connectionString: 'x' },
    AUTH_RATE_LIMITER: auth, API_RATE_LIMITER: floor,
    ...(opts.secret ? { CLIENT_ATTRIBUTION_SECRET: opts.secret } : {}),
    ...(opts.previous ? { CLIENT_ATTRIBUTION_SECRET_PREVIOUS: opts.previous } : {}),
  } as unknown as Bindings;
  const a = new Hono<{ Bindings: Bindings }>();
  a.route('/api/v1/auth', authRoutes);
  a.onError(errorHandler as never);
  const login = (email: string, headers: Record<string, string> = {}, password = 'pw') =>
    a.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password }) }, env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
  return { login, auth, floor };
}
const edge = (ip = EGRESS) => ({ 'cf-connecting-ip': ip, 'user-agent': 'web-worker/1' });
const signed = async (client: string, secret = SECRET, ts = Date.now()) => ({
  ...edge(),
  'x-echo-client': await signClientAttribution(secret, { ip: client, userAgent: `ua-${client}` }, ts),
});
const statusOf = async (p: Response | Promise<Response>) => (await p).status;
const ok = { accessToken: 'a', refreshToken: 'r' };

beforeEach(() => {
  vi.clearAllMocks();
  m.authKeys.length = 0;
  m.login.mockResolvedValue(ok);
});

describe('option A — shared web egress no longer locks out unrelated staff', () => {
  it('40 different staff behind ONE web egress sign in concurrently and none is throttled', async () => {
    const { login } = rig({ secret: SECRET, jitter: true });
    const results = await Promise.all(Array.from({ length: 40 }, async (_, i) => statusOf(login(`staff${i}@example.test`, await signed(`203.0.113.${i + 1}`)))));
    expect(results.every((s) => s === 200)).toBe(true);
  });
  it('one person typing a wrong password ten times does not affect a colleague on another network (the old cheap-DoS)', async () => {
    const { login } = rig();
    m.login.mockRejectedValue(new AuthError('Invalid email or password.', 'INVALID_CREDENTIALS'));
    for (let i = 0; i < 10; i++) await login('attacker@example.test', await signed('203.0.113.66'));
    expect(await statusOf(login('attacker@example.test', await signed('203.0.113.66')))).toBe(429);
    m.login.mockResolvedValue(ok);
    expect(await statusOf(login('owner@example.test', await signed('203.0.113.7')))).toBe(200);
  });
});

describe('option A — brute force is still stopped', () => {
  it('a signed source is capped at 10 attempts a minute across any emails, under concurrency', async () => {
    const { login } = rig({ secret: SECRET, jitter: true });
    const h = await signed('203.0.113.9');
    const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) => statusOf(login(`u${i}@example.test`, h))));
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });
  it('one account from one signed source is capped at 10 a minute', async () => {
    const { login } = rig();
    const h = await signed('203.0.113.10');
    const statuses = [];
    for (let i = 0; i < 14; i++) statuses.push(await statusOf(login('victim@example.test', h)));
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });
  it('a direct (unsigned) caller is capped at 10 a minute per address whatever emails it tries', async () => {
    const { login } = rig();
    const statuses = [];
    for (let i = 0; i < 15; i++) statuses.push(await statusOf(login(`d${i}@example.test`, edge('192.0.2.50'))));
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
  });
  it('distributed guessing of ONE account from many signed sources is capped by the account-wide floor (here 25/min)', async () => {
    const { login } = rig({ secret: SECRET, floor: 25, jitter: true });
    const statuses = await Promise.all(Array.from({ length: 80 }, async (_, i) => statusOf(login('victim@example.test', await signed(`203.0.113.${(i % 200) + 1}`)))));
    expect(statuses.filter((s) => s === 200)).toHaveLength(25);
  });
  it('an over-limit request is refused before the password is checked', async () => {
    const { login } = rig();
    const h = await signed('203.0.113.11');
    for (let i = 0; i < 10; i++) await login('a@example.test', h);
    m.login.mockClear();
    expect(await statusOf(login('a@example.test', h))).toBe(429);
    expect(m.login).not.toHaveBeenCalled();
  });
});

describe('option A — account-targeted lockouts are not cheap', () => {
  it('a signed attacker hammering a victim email cannot block the victim signing in from their own network', async () => {
    const { login } = rig();
    for (let i = 0; i < 50; i++) await login('victim@example.test', await signed('203.0.113.66'));
    expect(await statusOf(login('victim@example.test', await signed('203.0.113.7')))).toBe(200);
  });
  it('a direct attacker hammering a victim email cannot block the victim signing in through the web app', async () => {
    const { login } = rig();
    for (let i = 0; i < 12; i++) await login('victim@example.test', edge(`192.0.2.${100 + i}`));
    expect(await statusOf(login('victim@example.test', await signed('203.0.113.7')))).toBe(200);
  });
  it('email case and surrounding spaces do not escape an account bucket', async () => {
    const { login } = rig();
    const h = await signed('203.0.113.12');
    for (let i = 0; i < 10; i++) await login(i % 2 ? 'Victim@Example.test ' : 'victim@example.test', h);
    expect(await statusOf(login(' VICTIM@example.test', h))).toBe(429);
  });
});

describe('option A — spoofed or invalid attribution is rejected', () => {
  const cases: Array<[string, () => Promise<Record<string, string>>]> = [
    ['forged payload with a copied signature', async () => { const g = await signed('203.0.113.1'); const [v, , s] = g['x-echo-client']!.split('.'); return { ...edge(), 'x-echo-client': `${v}.${btoa(JSON.stringify({ ip: '203.0.113.99', ua: 'x', ts: Date.now() })).replace(/=+$/, '')}.${s}` }; }],
    ['signed with the wrong secret', () => signed('203.0.113.2', 'not-the-secret')],
    ['stale (older than 60 s)', () => signed('203.0.113.3', SECRET, Date.now() - 120_000)],
    ['from the future (beyond 5 s)', () => signed('203.0.113.4', SECRET, Date.now() + 60_000)],
    ['garbage', async () => ({ ...edge(), 'x-echo-client': 'garbage' })],
    ['an invalid client address inside a valid signature', async () => ({ ...edge(), 'x-echo-client': await signClientAttribution(SECRET, { ip: '1.1.1.1; drop', userAgent: 'x' }, Date.now()) })],
  ];
  it.each(cases)('%s is treated as a direct caller, never as a signed source', async (_n, make) => {
    const { login } = rig();
    const h = await make();
    for (let i = 0; i < 10; i++) await login(`s${i}@example.test`, h);
    expect(await statusOf(login('s99@example.test', h))).toBe(429);
    expect(m.authKeys.some((k) => k.startsWith('staff:login:source:'))).toBe(false);
    expect(m.authKeys.some((k) => k.startsWith('staff:login:direct:'))).toBe(true);
  });
  it('rotating forged headers cannot dodge the direct per-address bucket', async () => {
    const { login } = rig();
    for (let i = 0; i < 10; i++) await login('a@example.test', { ...edge('192.0.2.77'), 'x-echo-client': `v1.forged${i}.sig` });
    expect(await statusOf(login('a@example.test', { ...edge('192.0.2.77'), 'x-echo-client': 'v1.another.sig' }))).toBe(429);
  });
  it('a request with no edge address and no valid attribution falls into the single "unknown" direct bucket', async () => {
    const { login } = rig();
    for (let i = 0; i < 10; i++) await login(`u${i}@example.test`);
    expect(await statusOf(login('x@example.test'))).toBe(429);
    expect(m.authKeys.some((k) => k === 'staff:login:direct:unknown')).toBe(true);
  });
});

describe('option A — secret unset and rotation are safe', () => {
  it('with NO secret the behaviour is the previous one: a signed header is ignored and the per-IP bucket applies', async () => {
    const { login } = rig({});
    const h = await signed('203.0.113.20');
    for (let i = 0; i < 10; i++) await login(`u${i}@example.test`, h);
    expect(await statusOf(login('x@example.test', await signed('203.0.113.21')))).toBe(429); // same egress, shared bucket, as today
    expect(m.authKeys.every((k) => k === EGRESS)).toBe(true);
  });
  it('a previous secret alone (no current secret) enables nothing', async () => {
    const { login } = rig({ previous: OLD });
    for (let i = 0; i < 10; i++) await login(`u${i}@example.test`, await signed(`203.0.113.${i + 30}`, OLD));
    expect(await statusOf(login('x@example.test', await signed('203.0.113.99', OLD)))).toBe(429);
  });
  it('during a rotation a header signed with EITHER the current or the previous secret is trusted', async () => {
    const { login } = rig({ secret: SECRET, previous: OLD });
    expect(await statusOf(login('a@example.test', await signed('203.0.113.40', OLD)))).toBe(200);
    expect(await statusOf(login('b@example.test', await signed('203.0.113.41', SECRET)))).toBe(200);
    expect(m.authKeys.filter((k) => k.startsWith('staff:login:source:'))).toEqual(['staff:login:source:203.0.113.40', 'staff:login:source:203.0.113.41']);
  });
  it('once the previous secret is removed, headers still signed with it are no longer trusted', async () => {
    const { login } = rig({ secret: SECRET });
    await login('a@example.test', await signed('203.0.113.42', OLD));
    expect(m.authKeys.some((k) => k.startsWith('staff:login:source:'))).toBe(false);
  });
  it('KNOWN ROLLOUT HAZARD (pinned): with the secret set on the API but the web Worker NOT signing, all web sign-ins share the egress bucket', async () => {
    const { login } = rig();
    for (let i = 0; i < 10; i++) await login(`staff${i}@example.test`, edge());
    expect(await statusOf(login('innocent@example.test', edge()))).toBe(429);
  });
});

describe('option A — existing staff login contract is preserved', () => {
  it('returns the same success body and the same 401 for bad credentials', async () => {
    const { login } = rig();
    const res = await login('a@example.test', await signed('203.0.113.50'));
    expect(await res.json()).toEqual({ success: true, data: ok });
    m.login.mockRejectedValue(new AuthError('Invalid email or password.', 'INVALID_CREDENTIALS'));
    const bad = await login('a@example.test', await signed('203.0.113.50'));
    expect(bad.status).toBe(401);
    expect((await bad.json() as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });
  it('records the signed client on the session when attributed, the edge values otherwise', async () => {
    const { login } = rig();
    await login('a@example.test', await signed('203.0.113.51'));
    expect(m.login).toHaveBeenLastCalledWith(expect.objectContaining({ ipAddress: '203.0.113.51', userAgent: 'ua-203.0.113.51' }));
    await login('b@example.test', edge('192.0.2.5'));
    expect(m.login).toHaveBeenLastCalledWith(expect.objectContaining({ ipAddress: '192.0.2.5', userAgent: 'web-worker/1' }));
  });
  it('keeps the staff and cashier key spaces apart and never puts the email or password in a key', async () => {
    const { login } = rig();
    await login('secret-person@example.test', await signed('203.0.113.52'), 'hunter2-very-secret');
    expect(m.authKeys.every((k) => k.startsWith('staff:login:'))).toBe(true);
    expect(m.authKeys.join('|')).not.toMatch(/secret-person|hunter2|cashier:/);
  });
  it('refuses an oversized body before parsing it, as the cashier endpoints do', async () => {
    const { login } = rig();
    const res = await login('a@example.test', await signed('203.0.113.53'), 'x'.repeat(9000));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('resolveClient rotation semantics (unit)', () => {
  const headerFor = async (secret: string) => new Headers({ 'cf-connecting-ip': EGRESS, 'x-echo-client': await signClientAttribution(secret, { ip: '203.0.113.60', userAgent: 'u' }, Date.now()) });
  it('trusts the current secret, the previous secret during rotation, and nothing else', async () => {
    expect((await resolveClient(await headerFor(SECRET), SECRET, Date.now(), OLD)).trusted).toBe(true);
    expect((await resolveClient(await headerFor(OLD), SECRET, Date.now(), OLD)).trusted).toBe(true);
    expect((await resolveClient(await headerFor('third-secret'), SECRET, Date.now(), OLD)).trusted).toBe(false);
  });
  it('never trusts the previous secret when no current secret is configured', async () => {
    expect((await resolveClient(await headerFor(OLD), undefined, Date.now(), OLD)).trusted).toBe(false);
    expect((await resolveClient(await headerFor(OLD), '', Date.now(), OLD)).trusted).toBe(false);
  });
});

describe('review H1/M1 — IPv6 aggregation and no direct account lockout', () => {
  it('rateLimitSource keys IPv6 by canonical /64 and IPv4 as is', async () => {
    const { rateLimitSource } = await import('../lib/client-attribution');
    expect(rateLimitSource('2001:DB8:1:1::7')).toBe('2001:db8:1:1::/64');
    expect(rateLimitSource('2001:db8:1:1:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:1::/64');
    expect(rateLimitSource('2001:db8:0:0::1')).toBe(rateLimitSource('2001:DB8::1'));
    expect(rateLimitSource('::')).toBe('0:0:0:0::/64');
    expect(rateLimitSource('203.0.113.9')).toBe('203.0.113.9');
    for (const bad of ['999.1.1.1', ':::::::', '1:2:3:4:5:6:7:8:9', '1::2::3', 'x', '', undefined]) expect(rateLimitSource(bad)).toBe('unknown');
  });
  it('one IPv6 host rotating within its /64 stays inside ONE signed source bucket (10/min)', async () => {
    const { login } = rig();
    let ok = 0;
    for (let i = 0; i < 40; i++) if ((await statusOf(login('victim@example.test', await signed(`2001:db8:1:1::${i.toString(16)}`)))) === 200) ok++;
    expect(ok).toBe(10);
  });
  it('rotating IPv6 within a /64 does not dodge the direct per-address bucket either', async () => {
    const { login } = rig();
    let ok = 0;
    for (let i = 0; i < 40; i++) if ((await statusOf(login(`u${i}@example.test`, edge(`2001:db8:2:2::${i.toString(16)}`)))) === 200) ok++;
    expect(ok).toBe(10);
  });
  it('a direct caller can no longer lock a named account for the web user (M1, hazard state included)', async () => {
    const { login } = rig();
    for (let i = 0; i < 60; i++) await login('victim@example.test', edge('192.0.2.99'));
    expect(await statusOf(login('victim@example.test', await signed('203.0.113.7')))).toBe(200);
  });
});
