import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { errorHandler } from '../lib/error-handler';
import { signClientAttribution } from '../lib/client-attribution';
import { globalApiRateLimit } from './rate-limit';

/** Atomic fixed-window limiter: `limit` requests per key, then refused; records every key it was asked about. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    counts,
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}
const SECRET = 'global-limiter-secret';

function rig(env: Record<string, unknown> = {}, cap = 300) {
  const api = limiter(cap);
  const a = new Hono<{ Bindings: Bindings }>();
  a.onError(errorHandler as never);
  a.use('*', globalApiRateLimit());
  a.get('/x', (c) => c.json({ ok: true }));
  const call = async (headers: Record<string, string>) =>
    (await a.request('/x', { headers }, { API_RATE_LIMITER: api, ...env } as unknown as Bindings)).status;
  return { api, call };
}
const edge = (ip: string) => ({ 'cf-connecting-ip': ip });
const signed = async (clientIp: string, edgeIp = '198.51.100.1', secret = SECRET, now = Date.now()) => ({
  'cf-connecting-ip': edgeIp,
  'x-echo-client': await signClientAttribution(secret, { ip: clientIp, userAgent: 'ua' }, now),
});

describe('H2 global API limiter — secret NOT configured (legacy, unchanged)', () => {
  it('keys by the raw edge address and ignores any attribution header', async () => {
    const { api, call } = rig();
    await call(edge('203.0.113.5'));
    await call(await signed('203.0.113.77', '203.0.113.5'));
    expect([...api.counts.keys()]).toEqual(['203.0.113.5']);
    expect(api.counts.get('203.0.113.5')).toBe(2);
  });
  it('a request with no edge address uses the single legacy "unknown" key', async () => {
    const { api, call } = rig();
    await call({});
    expect([...api.counts.keys()]).toEqual(['unknown']);
  });
  it('shared web egress still exhausts the shared bucket (the pre-existing weakness, pinned)', async () => {
    const { call } = rig({}, 5);
    for (let i = 0; i < 5; i++) expect(await call(edge('198.51.100.1'))).toBe(200);
    expect(await call(edge('198.51.100.1'))).toBe(429);
  });
});

describe('H2 global API limiter — secret configured', () => {
  const env = { CLIENT_ATTRIBUTION_SECRET: SECRET };
  it('signed users behind ONE shared web egress no longer share a bucket', async () => {
    const { call } = rig(env, 5);
    for (let i = 0; i < 5; i++) expect(await call(await signed('203.0.113.10'))).toBe(200);
    expect(await call(await signed('203.0.113.10'))).toBe(429); // the busy source is limited...
    for (let u = 0; u < 40; u++) expect(await call(await signed(`203.0.113.${100 + u}`))).toBe(200); // ...others are not
  });
  it('a hostile signed source exhausting its own bucket does not 429 anyone else', async () => {
    const { call } = rig(env, 300);
    for (let i = 0; i < 400; i++) await call(await signed('203.0.113.66'));
    expect(await call(await signed('203.0.113.7'))).toBe(200);
  });
  it('IPv6: rotating inside one /64 stays in ONE bucket; a different /64 is separate', async () => {
    const { api, call } = rig(env, 5);
    let ok = 0;
    for (let i = 0; i < 40; i++) if ((await call(await signed(`2001:db8:1:1::${i.toString(16)}`))) === 200) ok++;
    expect(ok).toBe(5);
    expect([...api.counts.keys()]).toEqual(['src:2001:db8:1:1::/64']);
    expect(await call(await signed('2001:db8:1:2::1'))).toBe(200);
  });
  it('direct (unsigned) callers keep the legacy per-address key and are limited per address', async () => {
    const { api, call } = rig(env, 5);
    for (let i = 0; i < 5; i++) expect(await call(edge('192.0.2.9'))).toBe(200);
    expect(await call(edge('192.0.2.9'))).toBe(429);
    expect(await call(edge('192.0.2.10'))).toBe(200);
    expect([...api.counts.keys()].every((k) => !k.startsWith('src:'))).toBe(true);
  });
  it('a direct caller cannot spend a signed user\'s budget, nor the reverse', async () => {
    const { call } = rig(env, 5);
    for (let i = 0; i < 20; i++) await call(edge('203.0.113.10')); // direct from the same address the signed user claims
    expect(await call(await signed('203.0.113.10'))).toBe(200);
  });
  const bad: Array<[string, () => Promise<Record<string, string>>]> = [
    ['signed with the wrong secret', () => signed('203.0.113.9', '192.0.2.50', 'other-secret')],
    ['stale (120 s old)', () => signed('203.0.113.9', '192.0.2.50', SECRET, Date.now() - 120_000)],
    ['future-dated (60 s ahead)', () => signed('203.0.113.9', '192.0.2.50', SECRET, Date.now() + 60_000)],
    ['garbage value', async () => ({ ...edge('192.0.2.50'), 'x-echo-client': 'v1.abc.def' })],
    ['an unsigned claimed address', async () => ({ ...edge('192.0.2.50'), 'x-echo-client': 'v1.' + btoa(JSON.stringify({ ip: '203.0.113.9', ua: 'u', ts: Date.now() })) + '.AAAA' })],
  ];
  it.each(bad)('%s is never trusted: it is keyed by the real edge address, never the claimed one', async (_n, make) => {
    const { api, call } = rig(env, 300);
    await call(await make());
    expect([...api.counts.keys()]).toEqual(['192.0.2.50']);
  });
  it('rotating forged headers cannot dodge the per-address bucket', async () => {
    const { call } = rig(env, 5);
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const h = { ...edge('192.0.2.50'), 'x-echo-client': `v1.${btoa(JSON.stringify({ ip: `203.0.113.${i}`, ua: 'u', ts: Date.now() }))}.AAAA` };
      if ((await call(h)) === 200) ok++;
    }
    expect(ok).toBe(5);
  });
  it('web Worker that fails to sign (value mismatch) behaves exactly as before: shared egress bucket', async () => {
    const { call } = rig(env, 5);
    for (let i = 0; i < 5; i++) expect(await call(await signed(`203.0.113.${i}`, '198.51.100.1', 'web-has-other-secret'))).toBe(200);
    expect(await call(await signed('203.0.113.200', '198.51.100.1', 'web-has-other-secret'))).toBe(429);
  });
  it('a previous secret is honoured only while a current one is set (rotation)', async () => {
    const both = rig({ CLIENT_ATTRIBUTION_SECRET: SECRET, CLIENT_ATTRIBUTION_SECRET_PREVIOUS: 'old-secret' });
    await both.call(await signed('203.0.113.4', '198.51.100.1', 'old-secret'));
    expect([...both.api.counts.keys()]).toEqual(['src:203.0.113.4']);
    const prevOnly = rig({ CLIENT_ATTRIBUTION_SECRET_PREVIOUS: 'old-secret' });
    await prevOnly.call(await signed('203.0.113.4', '198.51.100.1', 'old-secret'));
    expect([...prevOnly.api.counts.keys()]).toEqual(['198.51.100.1']);
  });
  it('the signed key never collides with a legacy or account key, and the 429 body is the standard one', async () => {
    const { api, call } = rig(env, 1);
    await call(await signed('203.0.113.4'));
    expect([...api.counts.keys()][0]).toBe('src:203.0.113.4');
    const a = new Hono<{ Bindings: Bindings }>();
    a.onError(errorHandler as never);
    a.use('*', globalApiRateLimit());
    a.get('/x', (c) => c.json({ ok: true }));
    const envB = { API_RATE_LIMITER: limiter(0), ...env } as unknown as Bindings;
    const res = await a.request('/x', { headers: edge('192.0.2.1') }, envB);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });
});
