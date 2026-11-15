import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';

/**
 * SEC-CASHIER-POST-R2 C3: adversarial CHARACTERIZATION of the STAFF login throttle (`POST /auth/login`). This block changes
 * NO behaviour: every test asserts what the code does TODAY, including its known weaknesses, so a later redesign (see
 * docs/STAFF-LOGIN-THROTTLING-DESIGN.md) has a precise baseline and cannot change it silently. Tests named KNOWN WEAKNESS
 * pin an undesirable behaviour on purpose; when the design is implemented they are expected to change, deliberately.
 *
 * Uses the REAL `rateLimit` middleware and the REAL staff login route; only the account service, database and password
 * hasher are replaced. The limiter binding is a counting fake with the production settings (AUTH_RATE_LIMITER: 10 / 60 s).
 */
const m = vi.hoisted(() => ({ login: vi.fn(), keys: [] as string[] }));
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

const LIMIT = 10;
function limiter(limit: number) {
  const hits = new Map<string, number>();
  return {
    hits,
    limit: async ({ key }: { key: string }) => {
      m.keys.push(key);
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}
function rig() {
  const auth = limiter(LIMIT);
  const api = limiter(300);
  const env = { JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'r', HYPERDRIVE: { connectionString: 'x' }, AUTH_RATE_LIMITER: auth, API_RATE_LIMITER: api } as unknown as Bindings;
  const a = new Hono<{ Bindings: Bindings }>();
  a.route('/api/v1/auth', authRoutes);
  a.onError(errorHandler as never);
  const login = (email: string, headers: Record<string, string> = {}, password = 'pw') =>
    a.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password }) }, env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
  return { login, auth };
}
const ip = (addr: string) => ({ 'cf-connecting-ip': addr });
const WEB_EGRESS = ip('198.51.100.250');

beforeEach(() => {
  vi.clearAllMocks();
  m.keys.length = 0;
  m.login.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
});

describe('staff login throttle — what protects it today', () => {
  it('limits ONE source address to 10 attempts a minute, whatever emails it tries (credential stuffing from one IP is capped)', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) expect((await login(`u${i}@example.test`, ip('192.0.2.1'))).status).toBe(200);
    const blocked = await login('another@example.test', ip('192.0.2.1'));
    expect(blocked.status).toBe(429);
    expect(m.login).toHaveBeenCalledTimes(LIMIT); // the blocked attempt never reached password verification
  });
  it('keeps different source addresses independent', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) await login('a@example.test', ip('192.0.2.1'));
    expect((await login('a@example.test', ip('192.0.2.2'))).status).toBe(200);
  });
  it('the 429 is identical for a real and a non-existent account (no account-existence signal from throttling)', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) await login('real@example.test', ip('192.0.2.1'));
    const a = await login('real@example.test', ip('192.0.2.1'));
    const b = await login('ghost@example.test', ip('192.0.2.1'));
    expect([a.status, b.status]).toEqual([429, 429]);
    expect(await a.json()).toEqual(await b.json());
  });
  it('a failed password still costs one attempt (wrong passwords are throttled like right ones)', async () => {
    const { login } = rig();
    m.login.mockRejectedValue(new AuthError('Invalid email or password.', 'INVALID_CREDENTIALS'));
    for (let i = 0; i < LIMIT; i++) expect((await login('a@example.test', ip('192.0.2.3'))).status).toBe(401);
    expect((await login('a@example.test', ip('192.0.2.3'))).status).toBe(429);
  });
});

describe('staff login throttle — header spoofing cannot choose a bucket', () => {
  it('ignores x-forwarded-for, x-real-ip and a forged x-echo-client: only cf-connecting-ip keys the bucket', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) {
      await login('a@example.test', { ...ip('192.0.2.9'), 'x-forwarded-for': `10.0.0.${i}`, 'x-real-ip': `10.1.0.${i}`, 'x-echo-client': `v1.forged.${i}` });
    }
    const res = await login('a@example.test', { ...ip('192.0.2.9'), 'x-forwarded-for': '10.9.9.9', 'x-echo-client': 'v1.other.forged' });
    expect(res.status).toBe(429);
    expect(m.keys.every((k) => k === '192.0.2.9')).toBe(true);
  });
  it('a request with no cf-connecting-ip shares ONE bucket named "unknown" (KNOWN WEAKNESS: absent edge header = one global bucket)', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) await login(`u${i}@example.test`);
    expect((await login('x@example.test')).status).toBe(429);
    expect(new Set(m.keys)).toEqual(new Set(['unknown']));
  });
});

describe('staff login throttle — KNOWN WEAKNESSES (characterized, not fixed in this block)', () => {
  it('KNOWN WEAKNESS 1: every staff member signing in through the web app shares the web Worker egress address, so ten sign-ins a minute lock ALL staff out', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) expect((await login(`staff${i}@example.test`, WEB_EGRESS)).status).toBe(200);
    expect((await login('innocent@example.test', WEB_EGRESS)).status).toBe(429);
  });
  it('KNOWN WEAKNESS 2: one attacker through the web app can therefore lock out every staff member at will (cheap denial of service)', async () => {
    const { login } = rig();
    // The attacker types any ten wrong passwords through the public login form; the web Worker presents ITS address.
    for (let i = 0; i < LIMIT; i++) await login('attacker-guess@example.test', WEB_EGRESS);
    expect((await login('owner@example.test', WEB_EGRESS)).status).toBe(429);
  });
  it('KNOWN WEAKNESS 3: there is no per-account limit, so one account can be guessed at 10/min from EACH of many addresses', async () => {
    const { login } = rig();
    let accepted = 0;
    for (let i = 0; i < 50; i++) if ((await login('victim@example.test', ip(`203.0.113.${i + 1}`))).status !== 429) accepted++;
    expect(accepted).toBe(50); // 50 distinct sources, 50 attempts on the same account, none throttled
  });
  it('KNOWN WEAKNESS 4: the account service is never told about throttling, and there is no lockout state to recover from (nothing persists; the window just rolls)', async () => {
    const { login, auth } = rig();
    for (let i = 0; i < LIMIT + 5; i++) await login('a@example.test', ip('192.0.2.4'));
    expect(auth.hits.get('192.0.2.4')).toBe(LIMIT + 5); // counted per address only; no account key exists
    expect([...auth.hits.keys()]).toEqual(['192.0.2.4']);
  });
});

describe('staff login throttle — invariants a redesign must keep', () => {
  it('an over-limit request is refused BEFORE the password is checked (no CPU spent hashing for a blocked caller)', async () => {
    const { login } = rig();
    for (let i = 0; i < LIMIT; i++) await login('a@example.test', ip('192.0.2.5'));
    m.login.mockClear();
    await login('a@example.test', ip('192.0.2.5'));
    expect(m.login).not.toHaveBeenCalled();
  });
  it('the limiter key never contains the email or password (nothing secret is written to the rate-limit store)', async () => {
    const { login } = rig();
    await login('secret-person@example.test', ip('192.0.2.6'), 'hunter2-very-secret');
    expect(m.keys.join('|')).not.toMatch(/secret-person|hunter2/);
  });
});
