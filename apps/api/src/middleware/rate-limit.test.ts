import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { errorHandler } from '../lib/error-handler';
import { rateLimitByCustomer } from './rate-limit';

type Limiter = { limit: ReturnType<typeof vi.fn> };
const allow = (): Limiter => ({ limit: vi.fn(async () => ({ success: true })) });
const deny = (): Limiter => ({ limit: vi.fn(async () => ({ success: false })) });

function app(customerId: string | undefined) {
  const a = new Hono<{ Bindings: Bindings; Variables: { customerId: string } }>();
  a.onError(errorHandler as never);
  // stands in for customerAuthenticate, which runs first in every customer router
  a.use(
    '*',
    createMiddleware(async (c, next) => {
      if (customerId) c.set('customerId', customerId);
      await next();
    }),
    rateLimitByCustomer(),
  );
  a.get('/x', (c) => c.json({ ok: true }));
  return a;
}
const call = (
  a: ReturnType<typeof app>,
  env: Partial<Record<string, Limiter>>,
  ip = '203.0.113.9',
) => a.request('/x', { headers: { 'cf-connecting-ip': ip } }, env as unknown as Bindings);

describe('rateLimitByCustomer', () => {
  it('keys the limit by the authenticated customer, never by the shared IP', async () => {
    const limiter = allow();
    const env = { CUSTOMER_API_RATE_LIMITER: limiter, PUBLIC_RATE_LIMITER: allow() };
    await call(app('cust-a'), env, '203.0.113.1');
    await call(app('cust-a'), env, '198.51.100.7'); // same customer, different IP: same bucket
    await call(app('cust-b'), env, '203.0.113.1'); // same IP, different customer: different bucket
    expect(limiter.limit.mock.calls.map((c) => c[0])).toEqual([
      { key: 'customer:cust-a' },
      { key: 'customer:cust-a' },
      { key: 'customer:cust-b' },
    ]);
  });

  it('lets a request through when the customer is within budget', async () => {
    const response = await call(app('cust-a'), { CUSTOMER_API_RATE_LIMITER: allow() });
    expect(response.status).toBe(200);
  });

  it('answers 429 RATE_LIMITED when the customer is over budget', async () => {
    const response = await call(app('cust-a'), { CUSTOMER_API_RATE_LIMITER: deny() });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('falls back to the PUBLIC limiter, still keyed by customer, if the new binding is missing', async () => {
    const fallback = allow();
    const response = await call(app('cust-a'), { PUBLIC_RATE_LIMITER: fallback });
    expect(response.status).toBe(200);
    expect(fallback.limit).toHaveBeenCalledWith({ key: 'customer:cust-a' });
  });

  it('fails closed with 401 and never calls a limiter if no customer was authenticated', async () => {
    const limiter = allow();
    const response = await call(app(undefined), { CUSTOMER_API_RATE_LIMITER: limiter });
    expect(response.status).toBe(401);
    expect(limiter.limit).not.toHaveBeenCalled();
  });
});

describe('customer routers are not keyed by the shared IP', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith('.routes.ts') ? [path] : [];
    });

  it('every router that authenticates customers uses the per-customer limiter', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('customerAuthenticate,')) continue;
      checked += 1;
      const afterAuth = /customerAuthenticate,\s*([A-Za-z]+)\(/.exec(text)?.[1];
      if (afterAuth !== 'rateLimitByCustomer')
        offenders.push(file.replace(join(__dirname, '..'), 'src'));
    }
    expect(checked).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });
});
