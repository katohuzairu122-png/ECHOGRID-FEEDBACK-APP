import { describe, expect, it, vi } from 'vitest';
import { createSharedEmailAuthLimiter, spendEmailAuthBudget } from './customer-email-rate-limit';

describe('customer email long-window budget', () => {
  it.each([[5, 900], [3, 3600], [10, 3600]])('enforces %i requests per %i seconds', async (limit, seconds) => {
    const state = new Map<string, unknown>();
    const setAlarm = vi.fn(async () => {});
    const store = {
      get: async (key: string) => state.get(key),
      put: async (key: string, value: unknown) => { state.set(key, value); },
      delete: async (key: string) => state.delete(key),
      setAlarm,
    } as unknown as Parameters<typeof spendEmailAuthBudget>[0];

    const start = 1_000;
    for (let i = 0; i < limit; i += 1) {
      expect(await spendEmailAuthBudget(store, start, limit, seconds)).toBe(true);
    }
    expect(await spendEmailAuthBudget(store, start + seconds * 1000 - 1, limit, seconds)).toBe(false);
    expect(setAlarm).toHaveBeenCalledExactlyOnceWith(start + seconds * 1000);
    expect(await spendEmailAuthBudget(store, start + seconds * 1000, limit, seconds)).toBe(true);
  });

  it('distinguishes denial from missing or failing shared storage', async () => {
    const input = { key: 'opaque-source', limit: 5, windowSeconds: 900 };
    await expect(createSharedEmailAuthLimiter()(input)).rejects.toThrow('unavailable');
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch })),
    };
    const limiter = createSharedEmailAuthLimiter(namespace as unknown as DurableObjectNamespace);
    expect(await limiter(input)).toBe(false);
    expect(namespace.idFromName).toHaveBeenCalledExactlyOnceWith('5/900:opaque-source');
    await expect(limiter(input)).rejects.toThrow('unavailable');
  });
});
