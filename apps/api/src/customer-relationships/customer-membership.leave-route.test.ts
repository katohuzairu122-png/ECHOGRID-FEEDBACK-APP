import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import { customerMembershipSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import type { CustomerAuthVariables } from '../middleware/customer-authenticate';
import { AppError } from '../lib/errors';
import { customerMembershipRoutes } from './customer-membership.routes';

const mocks = vi.hoisted(() => ({ leave: vi.fn() }));

vi.mock('../middleware/customer-authenticate', () => ({
  customerAuthenticate: async (c: Context<{ Variables: CustomerAuthVariables }>, next: Next) => {
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
vi.mock('../repositories', () => ({ createRepositories: () => ({}) }));
vi.mock('./customer-membership.service', () => ({
  CustomerMembershipService: class {
    leave = mocks.leave;
  },
}));

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

const BUSINESS_ID = '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11';

/** A membership row as the database returns it: DTO fields plus internal columns. */
const leftRow = {
  id: '5c1c7a77-0d0a-4a54-8f4e-1d0f5f6a7b88',
  customerId: '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12',
  businessId: BUSINESS_ID,
  status: 'left' as const,
  joinedAt: new Date('2026-11-01T10:00:00.000Z'),
  leftAt: new Date('2026-11-18T09:30:00.000Z'),
  suspendedAt: null,
  businessExitedAt: null,
  closedAt: null,
  onboardingSource: 'business_qr',
  onboardingReference: 'qr-1',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  createdBy: null,
  updatedAt: new Date('2026-11-18T09:30:00.000Z'),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
};

function leave(businessId: string) {
  const app = new Hono<Env>();
  app.onError((err, c) =>
    c.json(
      { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
      err instanceof AppError ? err.status : 500,
    ),
  );
  app.route('/customer-memberships', customerMembershipRoutes);
  return app.fetch(
    new Request(`https://example.test/customer-memberships/${businessId}/leave`, {
      method: 'POST',
    }),
    {} as Bindings,
    { waitUntil() {}, passThroughOnException() {}, props: {} },
  );
}

beforeEach(() => vi.resetAllMocks());

describe('POST /customer-memberships/:businessId/leave', () => {
  it('leaves the caller’s own membership and returns it as the customer-facing DTO', async () => {
    mocks.leave.mockResolvedValueOnce(leftRow);

    const response = await leave(BUSINESS_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: unknown };
    expect(body.success).toBe(true);
    expect(mocks.leave).toHaveBeenCalledExactlyOnceWith('customer-a', BUSINESS_ID);
    // Exactly the declared fields: no audit columns, soft-delete flags or exit timestamps.
    expect(body.data).toEqual({
      id: leftRow.id,
      customerId: leftRow.customerId,
      businessId: BUSINESS_ID,
      status: 'left',
      joinedAt: '2026-11-01T10:00:00.000Z',
      leftAt: '2026-11-18T09:30:00.000Z',
      onboardingSource: 'business_qr',
      onboardingReference: 'qr-1',
    });
    expect(customerMembershipSchema.safeParse(body.data).success).toBe(true);
  });

  it('answers a malformed business id with a 404 without reaching the service or the database', async () => {
    const response = await leave('not-a-uuid');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'CUSTOMER_MEMBERSHIP_NOT_FOUND' });
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'CUSTOMER_MEMBERSHIP_NOT_FOUND'],
    [409, 'MEMBERSHIP_NOT_LEAVABLE'],
  ] as const)('maps the service refusing with %s %s', async (status, code) => {
    mocks.leave.mockRejectedValueOnce(new AppError('refused', status, code));

    const response = await leave(BUSINESS_ID);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });

  it('does not hide a database failure behind a success', async () => {
    mocks.leave.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await leave(BUSINESS_ID);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'UNEXPECTED' });
  });
});
