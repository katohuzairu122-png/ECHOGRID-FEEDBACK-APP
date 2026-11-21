import { describe, expect, it, vi } from 'vitest';
import { createCustomerEmailLinkComposition, type CustomerEmailLinkRuntime } from './customer-email-link.composition';

function runtime() {
  const requestProof = vi.fn(async () => {});
  const complete = vi.fn(async () => true);
  const value: CustomerEmailLinkRuntime = {
    dependencies: {
      sessions: { authenticateSessionToken: async () => ({
        assurance: 'session' as const,
        customerId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000002',
        authMethod: 'otp' as const,
        stepUpVerifiedAt: new Date(),
      }) },
      link: { requestProof, complete } as never,
      limiter: {
        resolveTrustedSource: async () => 'trusted-source',
        keyForIdentifier: async () => 'opaque-email-digest',
        limit: async () => true,
      },
    },
    close: async () => {},
  };
  return { value, requestProof, complete };
}

describe('isolated customer email-link composition', () => {
  it('answers a generic 404 and never opens the link runtime unless both gates are on', async () => {
    const open = vi.fn(async () => runtime().value);
    const app = createCustomerEmailLinkComposition({ isEnabled: () => false, open });
    const response = await app.request('/email/link/request', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  it('fails closed when the enabled runtime cannot be configured', async () => {
    const app = createCustomerEmailLinkComposition({ isEnabled: () => true, open: async () => null });
    expect((await app.request('/email/link/request', { method: 'POST' })).status).toBe(503);
  });

  it('routes a trusted owner-bound request only through the isolated link service', async () => {
    const fixture = runtime();
    const app = createCustomerEmailLinkComposition({ isEnabled: () => true, open: async () => fixture.value });
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const response = await app.request('/email/link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer otp-session-access' },
      body: JSON.stringify({ email: 'customer@example.test' }),
    }, {}, ctx);
    expect(response.status).toBe(202);
    expect(fixture.requestProof).toHaveBeenCalledOnce();
    expect(fixture.complete).not.toHaveBeenCalled();
  });
});
