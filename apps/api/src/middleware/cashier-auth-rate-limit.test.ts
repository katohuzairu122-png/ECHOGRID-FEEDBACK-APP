import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cashierAuthRateLimit } from './rate-limit';
import { signClientAttribution, verifyClientAttribution, resolveClient } from '../lib/client-attribution';
import { errorHandler } from '../lib/error-handler';

const SECRET = 's3cret-for-tests';

/** A counting limiter: allows `limit` hits per key, like the Cloudflare binding. */
const limiter = (limit: number) => {
  const hits = new Map<string, number>();
  return { limit: async ({ key }: { key: string }) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return { success: n <= limit }; }, hits };
};

function app(env: Record<string, unknown>) {
  const a = new Hono();
  a.onError(errorHandler as never);
  a.post('/login', cashierAuthRateLimit('login'), (c) => c.json({ ok: true }));
  a.post('/refresh', cashierAuthRateLimit('refresh'), (c) => c.json({ ok: true }));
  return (path: string, body: unknown, headers: Record<string, string> = {}) =>
    a.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }, env);
}
const status = async (p: Response | Promise<Response>) => (await p).status;

describe('client attribution', () => {
  it('accepts a fresh signed header and ignores forged, tampered, stale or unconfigured ones', async () => {
    const now = 1_000_000;
    const good = await signClientAttribution(SECRET, { ip: '203.0.113.7', userAgent: 'ua' }, now);
    expect(await verifyClientAttribution(SECRET, good, now + 1000)).toEqual({ ip: '203.0.113.7', userAgent: 'ua' });
    expect(await verifyClientAttribution('other', good, now)).toBeNull();
    expect(await verifyClientAttribution(undefined, good, now)).toBeNull();
    expect(await verifyClientAttribution(SECRET, good, now + 61_000)).toBeNull();
    expect(await verifyClientAttribution(SECRET, 'v1.abc.def', now)).toBeNull();
    const [v, p, s] = good.split('.');
    const forged = btoa(JSON.stringify({ ip: '198.51.100.9', ua: 'x', ts: now })).replace(/=+$/, '');
    expect(await verifyClientAttribution(SECRET, `${v}.${forged}.${s}`, now)).toBeNull();
    expect(p).toBeTruthy();
  });
  it('falls back to cf-connecting-ip as untrusted when no valid header is present', async () => {
    const h = new Headers({ 'cf-connecting-ip': '192.0.2.1', 'x-echo-client': 'v1.spoof.spoof' });
    expect(await resolveClient(h, SECRET)).toMatchObject({ ip: '192.0.2.1', trusted: false });
  });
});

describe('cashierAuthRateLimit (F6)', () => {
  it('one account from one source is capped, but other accounts sharing the web egress are not locked out', async () => {
    const env = { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) };
    const call = app(env);
    for (let i = 0; i < 10; i++) expect(await status(call('/login', { email: 'a@x.test' }))).toBe(200);
    expect(await status(call('/login', { email: 'a@x.test' }))).toBe(429);
    for (let i = 0; i < 10; i++) expect(await status(call('/login', { email: `u${i}@x.test` }))).toBe(200);
  });
  it('a spoofed attribution header cannot pick a bucket or dodge the account limit', async () => {
    const env = { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300), CLIENT_ATTRIBUTION_SECRET: SECRET };
    const call = app(env);
    for (let i = 0; i < 10; i++) await call('/login', { email: 'a@x.test' }, { 'x-echo-client': `v1.x.${i}` });
    expect(await status(call('/login', { email: 'a@x.test' }, { 'x-echo-client': 'v1.y.z' }))).toBe(429);
  });
  it('signed sources get independent per-account buckets and a per-source credential-stuffing cap', async () => {
    const env = { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300), CLIENT_ATTRIBUTION_SECRET: SECRET };
    const call = app(env);
    const hdr = async (ip: string) => ({ 'x-echo-client': await signClientAttribution(SECRET, { ip, userAgent: 'u' }, Date.now()) });
    for (let i = 0; i < 10; i++) expect(await status(call('/login', { email: `s${i}@x.test` }, await hdr('203.0.113.1')))).toBe(200);
    expect(await status(call('/login', { email: 'fresh@x.test' }, await hdr('203.0.113.1')))).toBe(429);
    expect(await status(call('/login', { email: 'fresh@x.test' }, await hdr('203.0.113.2')))).toBe(200);
  });
  it('distributed guessing of one account is capped by the account-wide floor', async () => {
    const env = { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(5), CLIENT_ATTRIBUTION_SECRET: SECRET };
    const call = app(env);
    let blocked = 0;
    for (let i = 0; i < 8; i++) {
      const h = { 'x-echo-client': await signClientAttribution(SECRET, { ip: `203.0.113.${i + 1}`, userAgent: 'u' }, Date.now()) };
      if ((await status(call('/login', { email: 'victim@x.test' }, h))) === 429) blocked++;
    }
    expect(blocked).toBe(3);
  });
  it('repeated refresh-token replay is limited per token; distinct tokens are not', async () => {
    const env = { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) };
    const call = app(env);
    for (let i = 0; i < 10; i++) await call('/refresh', { refreshToken: 'tok' });
    expect(await status(call('/refresh', { refreshToken: 'tok' }))).toBe(429);
    expect(await status(call('/refresh', { refreshToken: 'tok2' }))).toBe(200);
  });
});
