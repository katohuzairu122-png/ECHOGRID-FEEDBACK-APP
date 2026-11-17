import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSharedEmailAuthLimiter } from '../../src/customer-auth/customer-email-rate-limit';

const namespace = (env as unknown as { CUSTOMER_AUTH_RATE_LIMIT: DurableObjectNamespace }).CUSTOMER_AUTH_RATE_LIMIT;

describe('customer email rate limiter in the real Workers runtime (Durable Object)', () => {
  it('CONCURRENT requests cannot exceed the budget: 25 parallel calls against one 5-per-window key allow exactly 5', async () => {
    const limiter = createSharedEmailAuthLimiter(namespace);
    const key = `same-key-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter({ key, limit: 5, windowSeconds: 900 })));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.filter((allowed) => !allowed)).toHaveLength(20);
  });

  it('keys are isolated: exhausting one key leaves another untouched', async () => {
    const limiter = createSharedEmailAuthLimiter(namespace);
    const a = `iso-a-${crypto.randomUUID()}`;
    const b = `iso-b-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i += 1) expect(await limiter({ key: a, limit: 5, windowSeconds: 900 })).toBe(true);
    expect(await limiter({ key: a, limit: 5, windowSeconds: 900 })).toBe(false);
    expect(await limiter({ key: b, limit: 5, windowSeconds: 900 })).toBe(true);
  });

  it('the same key under a different budget is a separate counter (limit/window are part of the identity)', async () => {
    const limiter = createSharedEmailAuthLimiter(namespace);
    const key = `budget-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i += 1) expect(await limiter({ key, limit: 5, windowSeconds: 900 })).toBe(true);
    expect(await limiter({ key, limit: 5, windowSeconds: 900 })).toBe(false);
    expect(await limiter({ key, limit: 3, windowSeconds: 3600 })).toBe(true);
  });

  it('an unsupported budget is refused, never silently allowed', async () => {
    await expect(createSharedEmailAuthLimiter(namespace)({ key: 'x', limit: 999, windowSeconds: 1 })).rejects.toThrow();
  });
});

describe("fetch redirect semantics in the real Workers runtime", () => {
  it("redirect:'error' throws a TypeError before any request is sent; 'manual' and 'follow' are accepted", () => {
    expect(() => new Request('https://example.test/', { redirect: 'error' as never })).toThrow(TypeError);
    expect(() => new Request('https://example.test/', { redirect: 'manual' })).not.toThrow();
    expect(() => new Request('https://example.test/', { redirect: 'follow' })).not.toThrow();
  });
});
