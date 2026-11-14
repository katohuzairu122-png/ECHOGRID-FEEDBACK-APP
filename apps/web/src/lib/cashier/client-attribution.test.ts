import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => h.map.get(k) ?? null }) }));
import { clientAttributionHeaders } from './client-attribution';

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
