import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { errorHandler } from '../lib/error-handler';
import { signClientAttribution } from '../lib/client-attribution';
import {
  passwordChangeRateLimit,
  passwordResetConfirmRateLimit,
  passwordResetRequestRateLimit,
  signupRateLimit,
} from '../middleware/rate-limit';

const SECRET = 'h3-secret';
const counting = (limit: number) => {
  const hits = new Map<string, number>();
  return { hits, limit: async ({ key }: { key: string }) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return { success: n <= limit }; } };
};

/** Stand-in for `authenticate`: authorizes by the bearer token ONLY (never by anything attribution-related). */
const fakeAuthenticate = createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
  const m = /^Bearer (u\d+)$/.exec(c.req.header('authorization') ?? '');
  if (!m) return c.json({ success: false, error: { code: 'UNAUTHENTICATED' } }, 401);
  c.set('userId', m[1]!);
  await next();
});

function rig(env: Record<string, unknown> = {}, strict = 10, floor = 300) {
  const auth = counting(strict);
  const api = counting(floor);
  const a = new Hono<{ Bindings: Bindings }>();
  a.onError(errorHandler as never);
  a.post('/signup', signupRateLimit(), (c) => c.json({ ok: true }, 201));
  a.post('/reset-request', passwordResetRequestRateLimit(), (c) => c.body(null, 202));
  a.post('/reset-confirm', passwordResetConfirmRateLimit(), (c) => c.body(null, 204));
  a.post('/change', fakeAuthenticate as never, passwordChangeRateLimit(), (c) => c.body(null, 204));
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    (await a.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }, { AUTH_RATE_LIMITER: auth, API_RATE_LIMITER: api, ...env } as unknown as Bindings));
  return { auth, api, call };
}
const edge = (ip: string, extra: Record<string, string> = {}) => ({ 'cf-connecting-ip': ip, ...extra });
const signed = async (client: string, extra: Record<string, string> = {}, secret = SECRET, now = Date.now()) => ({
  'cf-connecting-ip': '198.51.100.250', // the shared web egress
  'x-echo-client': await signClientAttribution(secret, { ip: client, userAgent: 'u' }, now),
  ...extra,
});
const ON = { CLIENT_ATTRIBUTION_SECRET: SECRET };

type Case = { name: string; path: string; body: (i: number) => unknown; ok: number; extra?: Record<string, string>; subjectBody: unknown };
const cases: Case[] = [
  { name: 'signup', path: '/signup', body: (i) => ({ email: `u${i}@x.test`, password: 'p', fullName: 'n' }), ok: 201, subjectBody: { email: 'victim@x.test', password: 'p', fullName: 'n' } },
  { name: 'reset-request', path: '/reset-request', body: (i) => ({ email: `u${i}@x.test` }), ok: 202, subjectBody: { email: 'victim@x.test' } },
  { name: 'reset-confirm', path: '/reset-confirm', body: (i) => ({ token: `t${i}`.padEnd(64, 'a'), newPassword: 'x' }), ok: 204, subjectBody: { token: 'victimtoken'.padEnd(64, 'a'), newPassword: 'x' } },
  { name: 'password-change', path: '/change', body: () => ({ currentPassword: 'a', newPassword: 'b' }), ok: 204, extra: { authorization: 'Bearer u1' }, subjectBody: { currentPassword: 'a', newPassword: 'b' } },
];

describe.each(cases)('H3 $name — secret NOT configured (previous behaviour)', (cs) => {
  it('keeps the strict per-IP bucket on the raw address; another address is unaffected', async () => {
    const { call } = rig();
    for (let i = 0; i < 10; i++) expect((await call(cs.path, cs.body(i), edge('192.0.2.1', cs.extra))).status).toBe(cs.ok);
    expect((await call(cs.path, cs.body(11), edge('192.0.2.1', cs.extra))).status).toBe(429);
    expect((await call(cs.path, cs.body(12), edge('192.0.2.2', cs.extra))).status).toBe(200 + (cs.ok - 200));
  });
  it('a forged attribution header changes nothing; no account-keyed strict bucket exists (no lockout from other addresses)', async () => {
    const { call } = rig();
    for (let i = 0; i < 30; i++) await call(cs.path, cs.subjectBody, edge(`192.0.2.${10 + i}`, { ...cs.extra, 'x-echo-client': 'v1.forged.sig' }));
    expect((await call(cs.path, cs.subjectBody, edge('192.0.2.200', cs.extra))).status).toBe(cs.ok);
  });
});

describe.each(cases)('H3 $name — secret configured', (cs) => {
  it('signed users behind ONE web egress do not share a bucket (a hostile source exhausts only itself)', async () => {
    const { call } = rig(ON);
    for (let i = 0; i < 40; i++) await call(cs.path, cs.body(i), await signed('203.0.113.66', cs.extra));
    for (let u = 0; u < 25; u++) expect((await call(cs.path, cs.body(u + 100), await signed(`203.0.113.${100 + u}`, cs.extra))).status).toBe(cs.ok);
  });
  it('no account-wide strict bucket: ten sources hammering one subject cannot lock the victim out', async () => {
    const { call } = rig(ON);
    for (let s = 0; s < 10; s++) for (let i = 0; i < 9; i++) await call(cs.path, cs.subjectBody, await signed(`203.0.113.${20 + s}`, cs.extra));
    expect((await call(cs.path, cs.subjectBody, await signed('203.0.113.7', cs.extra))).status).toBe(cs.ok);
  });
  it('direct (unsigned) callers get a per-address bucket only and cannot hold a subject against signed users', async () => {
    const { call } = rig(ON);
    for (let i = 0; i < 60; i++) await call(cs.path, cs.subjectBody, edge('192.0.2.99', cs.extra));
    expect((await call(cs.path, cs.subjectBody, await signed('203.0.113.7', cs.extra))).status).toBe(cs.ok);
    expect((await call(cs.path, cs.subjectBody, edge('192.0.2.99', cs.extra))).status).toBe(429);
  });
  it('IPv6 rotation inside one /64 stays in ONE bucket', async () => {
    const { call } = rig(ON);
    let ok = 0;
    for (let i = 0; i < 40; i++) if ((await call(cs.path, cs.body(i), await signed(`2001:db8:1:1::${i.toString(16)}`, cs.extra))).status === cs.ok) ok++;
    expect(ok).toBe(10);
  });
  const bad: Array<[string, () => Promise<Record<string, string>>]> = [
    ['wrong secret', () => signed('203.0.113.9', cs.extra ?? {}, 'other')],
    ['stale', () => signed('203.0.113.9', cs.extra ?? {}, SECRET, Date.now() - 120_000)],
    ['future-dated', () => signed('203.0.113.9', cs.extra ?? {}, SECRET, Date.now() + 60_000)],
    ['garbage', async () => ({ ...edge('198.51.100.250', cs.extra), 'x-echo-client': 'v1.a.b' })],
  ];
  it.each(bad)('%s is treated as a direct caller and cannot pick a trusted bucket', async (_n, make) => {
    const { auth, call } = rig(ON);
    await call(cs.path, cs.body(1), await make());
    const keys = [...auth.hits.keys()];
    expect(keys.some((k) => k.includes(':direct:'))).toBe(true);
    expect(keys.some((k) => k.includes(':source:') || k.includes(':ip:'))).toBe(false);
  });
  it('the 429 body is the standard one', async () => {
    const { call } = rig(ON, 0);
    const res = await call(cs.path, cs.body(1), await signed('203.0.113.5', cs.extra));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });
  it('an over-limit request is refused identically whether the subject exists or not (no enumeration)', async () => {
    const { call } = rig(ON, 0);
    const a = await call(cs.path, cs.body(1), await signed('203.0.113.5', cs.extra));
    const b = await call(cs.path, cs.subjectBody, await signed('203.0.113.5', cs.extra));
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
  });
  it('oversized bodies are refused 400 before anything else', async () => {
    const { call } = rig(ON);
    const res = await call(cs.path, { pad: 'x'.repeat(9000) }, await signed('203.0.113.5', cs.extra));
    expect(res.status).toBe(400);
  });
});

describe('H3 password-change specifics', () => {
  const h = (user: string, ip: string) => signed(ip, { authorization: `Bearer ${user}` });
  it('is keyed by user and source: one user burning their budget never spends another user\'s (different sources)', async () => {
    const { call } = rig(ON);
    for (let i = 0; i < 40; i++) await call('/change', {}, await h('u1', '203.0.113.5'));
    expect((await call('/change', {}, await h('u2', '203.0.113.6'))).status).toBe(204);
  });
  it('documented limit: users on the SAME source share that source\'s strict budget (per-source bucket), 10/min', async () => {
    const { call } = rig(ON);
    for (let i = 0; i < 10; i++) await call('/change', {}, await h(`u${i}`, '203.0.113.5'));
    expect((await call('/change', {}, await h('u50', '203.0.113.5'))).status).toBe(429);
  });
  it('a stolen token used from another source cannot exhaust the owner\'s own-source budget', async () => {
    const { call } = rig(ON);
    for (let i = 0; i < 40; i++) await call('/change', {}, await h('u1', '203.0.113.66'));
    expect((await call('/change', {}, await h('u1', '203.0.113.7'))).status).toBe(204);
  });
  it('D2: attribution never affects authorization (no token = 401 even with a valid signed header; the user id comes from the token only)', async () => {
    const { auth, call } = rig(ON);
    expect((await call('/change', {}, await signed('203.0.113.5'))).status).toBe(401);
    expect(auth.hits.size).toBe(0); // refused before any limiter was touched
    await call('/change', {}, await h('u7', '203.0.113.5'));
    expect([...auth.hits.keys()].some((k) => k.startsWith('staff:password-change:subject:'))).toBe(true);
  });
  it('secret unset: per-IP bucket after authentication, unauthenticated calls never reach the limiter', async () => {
    const { call, auth } = rig();
    expect((await call('/change', {}, edge('192.0.2.1'))).status).toBe(401);
    expect(auth.hits.size).toBe(0);
  });
});
