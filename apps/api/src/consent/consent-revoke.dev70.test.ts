import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import type { Bindings } from '../config/env';
import type { CustomerAuthVariables } from '../middleware/customer-authenticate';
import { AppError } from '../lib/errors';
import { consentRoutes } from './consent.routes';

const mocks = vi.hoisted(() => ({
  revoke: vi.fn(),
}));

vi.mock('../middleware/customer-authenticate', () => ({
  customerAuthenticate: async (
    c: Context<{ Variables: CustomerAuthVariables }>,
    next: Next,
  ) => {
    c.set('customerId', 'customer-a');
    await next();
  },
}));
vi.mock('../middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: Next) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: Next) => next(),
  staffLoginRateLimit: () => async (_c: unknown, next: Next) => next(),
  cashierAuthRateLimit: () => async (_c: unknown, next: Next) => next(),
}));
vi.mock('../db/client', () => ({
  createDb: async () => ({ db: {}, close: async () => undefined }),
}));
vi.mock('../repositories', () => ({
  createRepositories: () => ({ consentGrants: {} }),
}));
// The route's job is the HTTP mapping of the service's boolean outcome. Whether
// a revoke also ends the loyalty membership is covered by
// consent-withdrawal.service.test.ts and the real-database lifecycle test.
vi.mock('./consent-withdrawal.service', () => ({
  ConsentWithdrawalService: class {
    revoke = mocks.revoke;
  },
}));

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

function request(grantId: string) {
  const app = new Hono<Env>();
  app.onError((err, c) => c.json(
    { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
    err instanceof AppError ? err.status : 500,
  ));
  app.route('/consents', consentRoutes);
  return app.fetch(new Request(`https://example.test/consents/${grantId}/revoke`, {
    method: 'POST',
  }), {} as Bindings, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  });
}

beforeEach(() => vi.resetAllMocks());

describe('DEV-70 accurate customer consent revocation HTTP outcomes', () => {
  it('only returns revoked true when an active grant belonging to the caller transitioned', async () => {
    const grantId = crypto.randomUUID();
    mocks.revoke.mockResolvedValueOnce(true);
    const response = await request(grantId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { revoked: true } });
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(grantId, 'customer-a');
  });

  it.each([
    'missing',
    'already revoked',
    "another customer's",
    'expired',
  ])('does not signal successful revocation for a grant that is %s', async () => {
    const grantId = crypto.randomUUID();
    mocks.revoke.mockResolvedValueOnce(false);
    const response = await request(grantId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'CONSENT_GRANT_NOT_ACTIVE' });
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(grantId, 'customer-a');
  });

  it.each(['not-a-uuid', 'grant-a', '123'])(
    'answers 404 for the malformed id %s without reaching the service (the database would reject it as a 500)',
    async (grantId) => {
      const response = await request(grantId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'CONSENT_GRANT_NOT_ACTIVE' });
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );

  it('does not swallow a database write error or claim successful revocation', async () => {
    mocks.revoke.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await request(crypto.randomUUID());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'UNEXPECTED' });
  });
});
