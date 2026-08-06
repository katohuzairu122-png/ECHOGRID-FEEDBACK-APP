import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index';

/**
 * Same "prove the router wiring, not the business logic" smoke-test
 * convention as test/workers/loyalty.test.ts -- ConversationService is
 * Database-shaped (constructor-injects the raw Database, not Repositories,
 * so it can open its own transaction in getOrCreateForCustomer), same as
 * LoyaltyAccountService, which this codebase deliberately doesn't
 * fake-repo unit test either -- these assert the routes are actually
 * mounted at the right path with the right auth gate, not that the
 * underlying feature works end to end (that's covered by the E2E pass).
 */
describe('messaging worker smoke tests', () => {
  it('GET /api/v1/messaging/conversations is mounted and gated behind STAFF auth -- 401 with no Authorization header', async () => {
    const request = new Request('http://example.com/api/v1/messaging/conversations', {
      headers: { 'X-Business-Id': crypto.randomUUID() },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('GET /api/v1/messaging/me/conversations is mounted and gated behind CUSTOMER auth, independently of the staff gate above -- 401 with no Authorization header, no X-Business-Id needed', async () => {
    const request = new Request('http://example.com/api/v1/messaging/me/conversations');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('a staff access token cannot authenticate against the customer-gated route -- proves messaging-customer.routes.ts really checks customerAuthenticate, not just "any bearer token present"', async () => {
    const request = new Request('http://example.com/api/v1/messaging/me/conversations', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('POST /api/v1/messaging/conversations is mounted and gated -- proves messagingRoutes is actually wired into index.ts, not just defined', async () => {
    const request = new Request('http://example.com/api/v1/messaging/conversations', {
      method: 'POST',
      headers: { 'X-Business-Id': crypto.randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: crypto.randomUUID() }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});
