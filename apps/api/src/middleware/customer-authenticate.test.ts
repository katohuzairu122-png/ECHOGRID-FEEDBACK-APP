import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { Customer } from '../repositories/customer.repository';

const mocks = vi.hoisted(() => ({
  findById: vi.fn<(id: string) => Promise<Customer | undefined>>(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({ customers: { findById: mocks.findById } })),
}));

const { customerAuthenticate } = await import('./customer-authenticate');
const { signCustomerAccessToken } = await import('../customer-auth/customer-jwt');
const { errorHandler } = await import('../lib/error-handler');

const JWT_SECRET = 'test-only-customer-secret';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const env = {
  CUSTOMER_JWT_SECRET: JWT_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://unused' },
} as unknown as Bindings;

const app = new Hono<{ Bindings: Bindings }>();
app.get('/protected', customerAuthenticate, (c) => c.json({ customerId: c.get('customerId') }));
app.onError(errorHandler);

function customer(status: Customer['status'] = 'active'): Customer {
  return {
    id: CUSTOMER_ID,
    phone: '+15551234567',
    fullName: null,
    email: null,
    birthday: null,
    phoneVerifiedAt: new Date(),
    status,
    createdAt: new Date(),
    createdBy: null,
    updatedAt: new Date(),
    updatedBy: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
  };
}

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

async function request(token: string): Promise<Response> {
  return app.request(
    '/protected',
    { headers: { authorization: `Bearer ${token}` } },
    env,
    executionCtx(),
  );
}

describe('customerAuthenticate account-state enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue(customer());
  });

  it('accepts an active customer and exposes the verified subject', async () => {
    const response = await request(await signCustomerAccessToken(CUSTOMER_ID, JWT_SECRET));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ customerId: CUSTOMER_ID });
    expect(mocks.findById).toHaveBeenCalledWith(CUSTOMER_ID);
  });

  it('rejects a suspended customer holding an otherwise valid access token', async () => {
    mocks.findById.mockResolvedValue(customer('suspended'));

    const response = await request(await signCustomerAccessToken(CUSTOMER_ID, JWT_SECRET));

    expect(response.status).toBe(401);
  });

  it('rejects a missing or soft-deleted customer excluded by the repository', async () => {
    mocks.findById.mockResolvedValue(undefined);

    const response = await request(await signCustomerAccessToken(CUSTOMER_ID, JWT_SECRET));

    expect(response.status).toBe(401);
  });
});

