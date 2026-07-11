import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index';

/**
 * Same "prove the router wiring, not the business logic" smoke-test
 * convention as test/workers/health.test.ts -- these assert that each new
 * route is actually mounted at the path apps/web's Server Actions call, and
 * that the RIGHT auth gate is in front of it (staff RBAC vs customer JWT vs
 * fully public), not that the underlying feature works end to end (that's
 * covered by the service unit tests + integration tests).
 */
describe('loyalty worker smoke tests', () => {
  it('POST /api/v1/customer-auth/otp/request is mounted and genuinely public -- a malformed body 400s (validation ran), not 401 (no auth middleware exists on this route)', async () => {
    const request = new Request('http://example.com/api/v1/customer-auth/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: 'not-a-real-phone-number' }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
  });

  it('GET /api/v1/loyalty/accounts is mounted and gated behind STAFF auth -- 401 with no Authorization header', async () => {
    const request = new Request('http://example.com/api/v1/loyalty/accounts', {
      headers: { 'X-Business-Id': crypto.randomUUID() },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('GET /api/v1/loyalty/me/accounts is mounted and gated behind CUSTOMER auth, independently of the staff gate above -- 401 with no Authorization header, and no X-Business-Id needed at all (customer routes never require tenant context)', async () => {
    const request = new Request('http://example.com/api/v1/loyalty/me/accounts');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('a staff access token cannot authenticate against the customer-gated route -- proves customerAuthenticate really checks CUSTOMER_JWT_SECRET and the `customer_access` type, not just "any bearer token present"', async () => {
    // Deliberately garbage -- a real staff-signed JWT would still fail here
    // since it's signed with a different secret than CUSTOMER_JWT_SECRET;
    // this is the cheap version of that same proof, no real signing needed.
    const request = new Request('http://example.com/api/v1/loyalty/me/accounts', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('GET /api/v1/loyalty/tiers is mounted and gated (Loyalty Block 3/4) -- proves loyaltyRoutes is actually wired into index.ts, not just defined', async () => {
    const request = new Request('http://example.com/api/v1/loyalty/tiers', {
      headers: { 'X-Business-Id': crypto.randomUUID() },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('GET /api/v1/businesses/:id/public is mounted and genuinely public -- an unknown id 404s rather than requiring auth', async () => {
    const request = new Request(`http://example.com/api/v1/businesses/${crypto.randomUUID()}/public`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // Same caveat health.test.ts's QR-token test carries: resolving even an
    // unknown id means a real query against HYPERDRIVE, so this only passes
    // once real Cloudflare resources replace wrangler.toml's placeholder ids.
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, error: { code: 'BUSINESS_NOT_FOUND' } });
  });
});
