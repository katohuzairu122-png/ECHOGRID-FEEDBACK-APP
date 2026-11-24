import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { Customer } from '../repositories/customer.repository';

const mocks = vi.hoisted(() => ({
  findById: vi.fn<(id: string) => Promise<Customer | undefined>>(),
  close: vi.fn(async () => undefined),
  findPending: vi.fn<(id: string) => Promise<{ scheduledFor: Date } | null>>(async () => null),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({ customers: { findById: mocks.findById }, customerDeletionRequests: { findPending: mocks.findPending } })),
}));

const { createCustomerAuthenticate, customerAuthenticate } = await import('./customer-authenticate');
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
    qrRevocationEpoch: 0,
    phone: '+15551234567',
    fullName: null,
    email: null,
    birthday: null,
    phoneVerifiedAt: new Date(),
    preferredLocale: null,
    status,
    suspendedUntil: null,
    limitedUntil: null,
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

  it('CUST-DEL-01: a pending deletion answers 403 ACCOUNT_DELETION_PENDING with the date on every ordinary route', async () => {
    const scheduledFor = new Date('2026-12-24T10:00:00Z');
    mocks.findPending.mockResolvedValue({ scheduledFor });

    const response = await request(await signCustomerAccessToken(CUSTOMER_ID, JWT_SECRET));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; details?: { scheduledFor: string } } };
    expect(body.error.code).toBe('ACCOUNT_DELETION_PENDING');
    expect(body.error.details?.scheduledFor).toBe(scheduledFor.toISOString());
  });

  it('CUST-DEL-01: a router that sets allowPendingDeletion is not blocked and does not even look the request up', async () => {
    mocks.findPending.mockResolvedValue({ scheduledFor: new Date() });
    const open = new Hono<{ Bindings: Bindings; Variables: { allowPendingDeletion?: boolean } }>();
    open.get('/', async (c, next) => { c.set('allowPendingDeletion', true); await next(); }, customerAuthenticate, (c) => c.json({ ok: true }));
    open.onError(errorHandler as never);

    const response = await open.request('/', { headers: { authorization: `Bearer ${await signCustomerAccessToken(CUSTOMER_ID, JWT_SECRET)}` } }, env, executionCtx());

    expect(response.status).toBe(200);
    expect(mocks.findPending).not.toHaveBeenCalled();
  });
});


describe('compatible customer authentication', () => {
  it('routes by token family and never tries legacy after a rotating denial', async () => {
    const session = vi.fn(async () => null);
    const legacy = vi.fn(async () => ({ assurance: 'legacy' as const, customerId: CUSTOMER_ID }));
    const compatible = new Hono<{ Bindings: Bindings }>();
    compatible.get('/', createCustomerAuthenticate({
      authenticateSessionToken: session, authenticateLegacyToken: legacy,
    }), (c) => c.json({ customerId: c.get('customerId') }));
    compatible.onError(errorHandler);
    const { signCustomerSessionAccessToken } = await import('../customer-auth/session-tokens');
    const rotatingToken = await signCustomerSessionAccessToken(CUSTOMER_ID, CUSTOMER_ID, 'synthetic-session-secret');
    const send = (token: string) => compatible.request('/', {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect((await send(rotatingToken)).status).toBe(401);
    expect(session).toHaveBeenCalledExactlyOnceWith(rotatingToken);
    expect(legacy).not.toHaveBeenCalled();
    expect((await send('invalid')).status).toBe(401);
    expect(legacy).not.toHaveBeenCalled();
    expect((await send(await signCustomerAccessToken(CUSTOMER_ID, JWT_SECRET))).status).toBe(200);
  });
});
