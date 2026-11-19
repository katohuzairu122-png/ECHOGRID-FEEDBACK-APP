import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import {
  customerMembershipSchema,
  joinCustomerMembershipResultSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import type { CustomerAuthVariables } from '../middleware/customer-authenticate';
import { AppError } from '../lib/errors';
import { customerMembershipRoutes } from './customer-membership.routes';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  find: vi.fn(),
  join: vi.fn(),
  resolveToken: vi.fn(),
}));

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
vi.mock('../repositories', () => ({
  createRepositories: () => ({
    customerMemberships: {
      listForCustomer: mocks.list,
      findByCustomerAndBusiness: mocks.find,
    },
  }),
}));
vi.mock('../qr/qr-code.service', () => ({
  QrCodeService: class {
    resolveToken = mocks.resolveToken;
  },
}));
vi.mock('./customer-membership.service', () => ({
  CustomerMembershipService: class {
    join = mocks.join;
  },
}));

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

const CUSTOMER_ID = '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12';
const BUSINESS_ID = '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11';
const OTHER_BUSINESS_ID = '3c5e7a90-2b4d-4f61-8a73-9b1d3f5a7c24';
const QR_ID = '6d8f0b12-4c6e-4a80-9b92-1d3f5a7c9e35';
const BRANCH_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

/** A membership row as the database returns it: DTO fields plus internal columns. */
const membershipRow = (businessId: string, status: 'active' | 'left' = 'active') => ({
  id: crypto.randomUUID(),
  customerId: CUSTOMER_ID,
  businessId,
  status,
  joinedAt: new Date('2026-11-01T10:00:00.000Z'),
  leftAt: status === 'left' ? new Date('2026-11-18T09:30:00.000Z') : null,
  suspendedAt: null,
  businessExitedAt: null,
  closedAt: null,
  onboardingSource: 'business_qr',
  onboardingReference: QR_ID,
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  createdBy: null,
  updatedAt: new Date('2026-11-01T10:00:00.000Z'),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
});

const accountRow = (businessId: string, membershipId: string) => ({
  id: crypto.randomUUID(),
  customerId: CUSTOMER_ID,
  businessId,
  membershipId,
  points: 0,
  tierId: null,
  referredByCustomerId: null,
  visitCount: 0,
  lastVisitAt: null,
  status: 'active',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  createdBy: null,
  updatedAt: new Date('2026-11-01T10:00:00.000Z'),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
});

const INTERNAL_MEMBERSHIP_FIELDS = [
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'isDeleted',
  'deletedAt',
  'deletedBy',
  'suspendedAt',
  'businessExitedAt',
  'closedAt',
];

function call(path: string, init?: RequestInit) {
  const app = new Hono<Env>();
  app.onError((err, c) =>
    c.json(
      { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
      err instanceof AppError ? err.status : 500,
    ),
  );
  app.route('/customer-memberships', customerMembershipRoutes);
  return app.fetch(
    new Request(`https://example.test/customer-memberships${path}`, init),
    {} as Bindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    },
  );
}

const joinRequest = (body: unknown) =>
  call('/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => vi.resetAllMocks());

describe('GET /customer-memberships', () => {
  it('returns the caller’s memberships as customer-facing DTOs, not raw rows', async () => {
    mocks.list.mockResolvedValueOnce([
      membershipRow(BUSINESS_ID),
      membershipRow(OTHER_BUSINESS_ID, 'left'),
    ]);

    const response = await call('');

    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('customer-a');
    const body = (await response.json()) as { data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(2);
    for (const item of body.data) {
      expect(customerMembershipSchema.safeParse(item).success).toBe(true);
      for (const internal of INTERNAL_MEMBERSHIP_FIELDS) expect(item).not.toHaveProperty(internal);
    }
    expect(body.data[1]).toMatchObject({ status: 'left', leftAt: '2026-11-18T09:30:00.000Z' });
  });

  it('returns an empty list for a customer with no memberships', async () => {
    mocks.list.mockResolvedValueOnce([]);

    const response = await call('');

    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

describe('GET /customer-memberships/:businessId', () => {
  it('returns the caller’s membership with that business as a DTO', async () => {
    mocks.find.mockResolvedValueOnce(membershipRow(BUSINESS_ID));

    const response = await call(`/${BUSINESS_ID}`);

    expect(response.status).toBe(200);
    expect(mocks.find).toHaveBeenCalledExactlyOnceWith('customer-a', BUSINESS_ID);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(customerMembershipSchema.safeParse(body.data).success).toBe(true);
    for (const internal of INTERNAL_MEMBERSHIP_FIELDS)
      expect(body.data).not.toHaveProperty(internal);
  });

  it('answers 404 when the caller has no membership with that business', async () => {
    mocks.find.mockResolvedValueOnce(undefined);

    const response = await call(`/${BUSINESS_ID}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'CUSTOMER_MEMBERSHIP_NOT_FOUND' });
  });

  it('answers a malformed business id with a 404 without querying (the database would reject it as a 500)', async () => {
    const response = await call('/not-a-uuid');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'CUSTOMER_MEMBERSHIP_NOT_FOUND' });
    expect(mocks.find).not.toHaveBeenCalled();
  });
});

describe('POST /customer-memberships/join', () => {
  const body = { qrToken: 'qr-token', consentAccepted: true };

  it('returns the customer-facing membership and account DTOs with 201', async () => {
    const membership = membershipRow(BUSINESS_ID);
    mocks.resolveToken.mockResolvedValueOnce({ id: QR_ID, businessId: BUSINESS_ID, branchId: BRANCH_ID });
    mocks.join.mockResolvedValueOnce({
      membership,
      loyaltyAccount: accountRow(BUSINESS_ID, membership.id),
    });

    const response = await joinRequest(body);

    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      data: { membership: object; loyaltyAccount: object };
    };
    expect(joinCustomerMembershipResultSchema.safeParse(json.data).success).toBe(true);
    for (const internal of INTERNAL_MEMBERSHIP_FIELDS)
      expect(json.data.membership).not.toHaveProperty(internal);
    for (const internal of ['membershipId', 'referredByCustomerId', 'createdBy', 'isDeleted']) {
      expect(json.data.loyaltyAccount).not.toHaveProperty(internal);
    }
  });

  it('joins the business the QR code resolves to, never one the caller names, recording the code as the source', async () => {
    const membership = membershipRow(BUSINESS_ID);
    mocks.resolveToken.mockResolvedValueOnce({ id: QR_ID, businessId: BUSINESS_ID, branchId: BRANCH_ID });
    mocks.join.mockResolvedValueOnce({
      membership,
      loyaltyAccount: accountRow(BUSINESS_ID, membership.id),
    });

    await joinRequest({ ...body, businessId: OTHER_BUSINESS_ID });

    expect(mocks.join).toHaveBeenCalledExactlyOnceWith({
      customerId: 'customer-a',
      businessId: BUSINESS_ID,
      onboardingSource: 'business_qr',
      onboardingReference: QR_ID,
      // 02D: the branch is the QR code's own, read server-side; never the request's
      attribution: { source: 'business_qr', branchId: BRANCH_ID, reference: QR_ID },
      consentVersion: 'v1',
    });
  });

  it('refuses a join without explicit consent before resolving the QR code', async () => {
    const response = await joinRequest({ qrToken: 'qr-token' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'VALIDATION_ERROR' });
    expect(mocks.resolveToken).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });
});
