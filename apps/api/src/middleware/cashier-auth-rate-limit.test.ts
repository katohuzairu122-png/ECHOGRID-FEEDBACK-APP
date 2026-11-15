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

const ip = (addr: string) => ({ 'cf-connecting-ip': addr });
const signed = async (addr: string) => ({
  ...ip('198.51.100.250'), // the web Worker's egress
  'x-echo-client': await signClientAttribution(SECRET, { ip: addr, userAgent: 'u' }, Date.now()),
});

describe('cashierAuthRateLimit without CLIENT_ATTRIBUTION_SECRET (shipped state: previous behaviour)', () => {
  const rig = () => app({ AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) });
  it('keeps the strict per-IP bucket on login and rotating emails does not escape it', async () => {
    const call = rig();
    for (let i = 0; i < 10; i++) expect(await status(call('/login', { email: `u${i}@x.test` }, ip('192.0.2.1')))).toBe(200);
    expect(await status(call('/login', { email: 'new@x.test' }, ip('192.0.2.1')))).toBe(429);
    expect(await status(call('/login', { email: 'new@x.test' }, ip('192.0.2.2')))).toBe(200);
  });
  it('cannot lock a named cashier out from another address (no strict account bucket exists)', async () => {
    const call = rig();
    for (let i = 0; i < 12; i++) await call('/login', { email: 'victim@x.test' }, ip(`192.0.2.${10 + i}`));
    expect(await status(call('/login', { email: 'victim@x.test' }, ip('192.0.2.99')))).toBe(200);
  });
  it('a forged attribution header changes nothing', async () => {
    const call = rig();
    for (let i = 0; i < 10; i++) await call('/login', { email: 'a@x.test' }, { ...ip('192.0.2.1'), 'x-echo-client': `v1.x.${i}` });
    expect(await status(call('/login', { email: 'a@x.test' }, { ...ip('192.0.2.1'), 'x-echo-client': 'v1.y.z' }))).toBe(429);
  });
  it('refresh replay of one token is bounded by the account/token floor; other tokens are not', async () => {
    const call = app({ AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(5) });
    for (let i = 0; i < 5; i++) expect(await status(call('/refresh', { refreshToken: 'tok' }, ip('192.0.2.1')))).toBe(200);
    expect(await status(call('/refresh', { refreshToken: 'tok' }, ip('192.0.2.1')))).toBe(429);
    expect(await status(call('/refresh', { refreshToken: 'tok2' }, ip('192.0.2.1')))).toBe(200);
  });
});

describe('cashierAuthRateLimit with CLIENT_ATTRIBUTION_SECRET configured', () => {
  const rig = (api = 300) => app({ AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(api), CLIENT_ATTRIBUTION_SECRET: SECRET });
  it('signed clients behind one web egress do not lock each other out; each source and account is capped separately', async () => {
    const call = rig();
    for (let i = 0; i < 10; i++) expect(await status(call('/login', { email: `s${i}@x.test` }, await signed('203.0.113.1')))).toBe(200);
    expect(await status(call('/login', { email: 'fresh@x.test' }, await signed('203.0.113.1')))).toBe(429); // per-source cap
    expect(await status(call('/login', { email: 'fresh@x.test' }, await signed('203.0.113.2')))).toBe(200); // another person, same egress
    for (let i = 0; i < 10; i++) await call('/login', { email: 'a@x.test' }, await signed('203.0.113.3'));
    expect(await status(call('/login', { email: 'a@x.test' }, await signed('203.0.113.3')))).toBe(429); // one account, one source
  });
  it('unsigned (direct) callers get the strict per-IP bucket, so rotating emails cannot exceed 10/min per IP', async () => {
    const call = rig();
    for (let i = 0; i < 10; i++) expect(await status(call('/login', { email: `u${i}@x.test` }, ip('192.0.2.1')))).toBe(200);
    expect(await status(call('/login', { email: 'new@x.test' }, ip('192.0.2.1')))).toBe(429);
  });
  it('a direct attacker exhausting a victim\'s unsigned bucket does not block that victim\'s signed sign-in', async () => {
    const call = rig();
    for (let i = 0; i < 12; i++) await call('/login', { email: 'victim@x.test' }, ip(`192.0.2.${10 + i}`));
    expect(await status(call('/login', { email: 'victim@x.test' }, await signed('203.0.113.9')))).toBe(200);
  });
  it('a forged or stale header is treated as direct, never as a signed source', async () => {
    const call = rig();
    for (let i = 0; i < 10; i++) await call('/login', { email: `f${i}@x.test` }, { ...ip('192.0.2.5'), 'x-echo-client': `v1.x.${i}` });
    expect(await status(call('/login', { email: 'f@x.test' }, { ...ip('192.0.2.5'), 'x-echo-client': 'v1.y.z' }))).toBe(429);
  });
  it('distributed guessing of one account is capped by the account-wide floor', async () => {
    const call = rig(5);
    let blocked = 0;
    for (let i = 0; i < 8; i++) if ((await status(call('/login', { email: 'victim@x.test' }, await signed(`203.0.113.${i + 1}`)))) === 429) blocked++;
    expect(blocked).toBe(3);
  });
});

describe('cashierAuthRateLimit request bounds', () => {
  const call = () => app({ AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) });
  it('refuses an oversized body (400 PAYLOAD_TOO_LARGE) before parsing it', async () => {
    expect(await status(call()('/login', { email: 'a@x.test', pad: 'x'.repeat(9000) }, ip('192.0.2.1')))).toBe(400);
  });
  it('still lets a non-JSON body through to the handler validation', async () => {
    const a = new Hono();
    a.onError(errorHandler as never);
    a.post('/login', cashierAuthRateLimit('login'), (c) => c.json({ ok: true }));
    const res = await a.request('/login', { method: 'POST', body: 'not json', headers: ip('192.0.2.1') }, { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) });
    expect(res.status).toBe(200);
  });
  it('refuses on a declared content-length over the cap even when the body itself is small (precheck)', async () => {
    const a = new Hono();
    a.onError(errorHandler as never);
    a.post('/login', cashierAuthRateLimit('login'), (c) => c.json({ ok: true }));
    const res = await a.request('/login', { method: 'POST', body: '{}', headers: { ...ip('192.0.2.1'), 'content-length': '99999' } }, { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) });
    expect(res.status).toBe(400);
  });
  it('stops reading a chunked body with no content-length once it passes the cap', async () => {
    const a = new Hono();
    a.onError(errorHandler as never);
    a.post('/login', cashierAuthRateLimit('login'), (c) => c.json({ ok: true }));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
        if (pulled > 1000) controller.close();
      },
    });
    const res = await a.request(new Request('http://x/login', { method: 'POST', body: stream, headers: ip('192.0.2.1'), duplex: 'half' } as RequestInit), undefined, { AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300) });
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(20);
  });
  it('unsigned callers have NO account-keyed strict bucket: one address cannot lock a named account for others (review M1)', async () => {
    const call = app({ AUTH_RATE_LIMITER: limiter(10), API_RATE_LIMITER: limiter(300), CLIENT_ATTRIBUTION_SECRET: SECRET });
    for (let i = 0; i < 12; i++) await status(call('/login', { email: 'same@x.test' }, ip('192.0.2.99')));
    expect(await status(call('/login', { email: 'same@x.test' }, ip('192.0.2.200')))).toBe(200);
  });

});
