import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => h.map.get(k) ?? null }) }));
import { clientAttributionHeaders, signedAttributionHeadersSafe } from './client-attribution';

describe('clientAttributionHeaders', () => {
  it('is empty without a secret or without a client address', async () => {
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
    h.map.set('cf-connecting-ip', '203.0.113.5');
    expect(await clientAttributionHeaders()).toEqual({});
    process.env.CLIENT_ATTRIBUTION_SECRET = 's';
    h.map.delete('cf-connecting-ip');
    expect(await clientAttributionHeaders()).toEqual({});
  });
  it('signs the connecting address when configured', async () => {
    process.env.CLIENT_ATTRIBUTION_SECRET = 's';
    h.map.set('cf-connecting-ip', '203.0.113.5');
    const out = await clientAttributionHeaders();
    expect(out['x-echo-client']).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
  });
});

describe('signedAttributionHeadersSafe (H2)', () => {
  it('signs for any caller when configured, and is empty when unconfigured', async () => {
    h.map.set('cf-connecting-ip', '2001:db8::7');
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
    expect(await signedAttributionHeadersSafe()).toEqual({});
    process.env.CLIENT_ATTRIBUTION_SECRET = 's';
    expect((await signedAttributionHeadersSafe())['x-echo-client']).toMatch(/^v1\./);
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
  });
  it('never throws outside a request scope: no header, so the API uses its legacy key', async () => {
    process.env.CLIENT_ATTRIBUTION_SECRET = 's';
    const mod = await import('next/headers');
    const spy = vi.spyOn(mod, 'headers').mockRejectedValueOnce(new Error('outside a request scope'));
    expect(await signedAttributionHeadersSafe()).toEqual({});
    spy.mockRestore();
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
  });
});
