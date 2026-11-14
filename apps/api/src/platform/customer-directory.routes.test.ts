import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { PlatformRole } from '../db/schema/users';

/**
 * Platform customer moderation routes. Real authenticate and
 * requirePlatformRole; only the database layer is faked (same approach as
 * ops.routes.test.ts), so a role change in requirePlatformRole shows up here.
 */
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const FULL_PHONE = '+96555551234';

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(async (_id: string) => undefined as unknown),
  customerFindById: vi.fn(async (_id: string) => undefined as unknown),
  list: vi.fn(async (_i: unknown) => [] as unknown[]),
  countBusinesses: vi.fn(async (_id: string) => 2),
  setModeration: vi.fn(async (_id: string, _p: unknown) => undefined as unknown),
  countWarnings: vi.fn(async (_id: string) => 0),
  listHistory: vi.fn(async (_id: string) => [] as unknown[]),
  record: vi.fn(async (_i: unknown) => ({
    id: '44444444-4444-4444-8444-444444444444',
    customerId: CUSTOMER_ID,
    action: 'warning',
    reason: 'x',
    suspendedUntil: null,
    actorUserId: null,
    createdAt: new Date('2026-11-13T00:00:00Z'),
  })),
  auditRecord: vi.fn(async (_i: unknown) => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({
    db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
    close: mocks.close,
  })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    users: { findById: mocks.userFindById },
    customers: {
      findById: mocks.customerFindById,
      listForPlatform: mocks.list,
      countBusinesses: mocks.countBusinesses,
      setModeration: mocks.setModeration,
    },
    customerSanctions: {
      countWarnings: mocks.countWarnings,
      listForCustomer: mocks.listHistory,
      record: mocks.record,
    },
    auditLog: { record: mocks.auditRecord },
  })),
}));

const { platformCustomerRoutes } = await import('./customer-directory.routes');
const { errorHandler } = await import('../lib/error-handler');
const { signAccessToken } = await import('../auth/jwt');

const JWT_SECRET = 'test-only-access-secret-not-a-real-value';
const env = {
  ENVIRONMENT: 'production',
  JWT_ACCESS_SECRET: JWT_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://unused' },
} as unknown as Bindings;

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/platform/customers', platformCustomerRoutes);
app.onError(errorHandler);

function asRole(platformRole: PlatformRole | null) {
  mocks.userFindById.mockResolvedValue({ id: ADMIN_ID, status: 'active', platformRole });
}

function customerRow(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    phone: FULL_PHONE,
    fullName: 'Secret Name',
    email: 'secret@example.test',
    status: 'active',
    suspendedUntil: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
) {
  const token = init.token === undefined ? await signAccessToken(ADMIN_ID, JWT_SECRET) : init.token;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(
    `/api/v1/platform/customers${path}`,
    {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
  );
}

async function codeOf(r: Response) {
  return ((await r.json()) as { error?: { code?: string } }).error?.code ?? '';
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  asRole('admin');
  mocks.customerFindById.mockResolvedValue(customerRow());
  mocks.setModeration.mockImplementation(async (_id: string, p: unknown) => ({
    ...customerRow(),
    ...(p as object),
  }));
});

describe('GET /platform/customers', () => {
  it('requires authentication', async () => {
    expect((await call('', { token: null })).status).toBe(401);
  });

  it('refuses billing and non-platform users', async () => {
    asRole('billing');
    expect((await call('')).status).toBe(403);
    asRole(null);
    expect((await call('')).status).toBe(403);
  });

  it('lets support list, with a masked phone and no personal data', async () => {
    asRole('support');
    mocks.list.mockResolvedValue([{ ...customerRow(), businessCount: 0 }]);
    const r = await call('?withoutBusiness=true');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(FULL_PHONE);
    expect(text).not.toContain('Secret Name');
    expect(text).not.toContain('secret@example.test');
    expect(text).toContain('+965');
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ withoutBusiness: true }));
  });

  it('rejects free-text search and accepts an id or full phone', async () => {
    expect((await call('?search=alice')).status).toBe(400);
    expect((await call(`?search=${encodeURIComponent(FULL_PHONE)}`)).status).toBe(200);
    expect((await call(`?search=${CUSTOMER_ID}`)).status).toBe(200);
  });

  it('caps the page size', async () => {
    await call('?limit=5000');
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('audits the view without storing the searched value', async () => {
    await call(`?search=${encodeURIComponent(FULL_PHONE)}`);
    const entry = mocks.auditRecord.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(entry.action).toBe('platform.customer_list_viewed');
    expect(entry.metadata.searchKind).toBe('phone');
    expect(JSON.stringify(entry)).not.toContain(FULL_PHONE);
  });
});

describe('POST /platform/customers/:id/sanctions', () => {
  it('is admin only', async () => {
    asRole('support');
    const r = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'warning', reason: 'Repeated misuse' },
    });
    expect(r.status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('records a warning without changing the customer', async () => {
    const r = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'warning', reason: 'Repeated misuse' },
    });
    expect(r.status).toBe(200);
    expect(mocks.setModeration).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'warning', actorUserId: ADMIN_ID }),
    );
  });

  it('refuses suspend or ban without a prior warning', async () => {
    mocks.countWarnings.mockResolvedValue(0);
    const s = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'suspend', reason: 'Fraud pattern', suspendedUntil: future(7) },
    });
    expect(s.status).toBe(409);
    expect(await codeOf(s)).toBe('WARNING_REQUIRED');
    const b = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'ban', reason: 'Fraud pattern' },
    });
    expect(b.status).toBe(409);
    expect(mocks.setModeration).not.toHaveBeenCalled();
  });

  it('suspends for a period after a warning, and bans', async () => {
    mocks.countWarnings.mockResolvedValue(1);
    const until = future(7);
    const s = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'suspend', reason: 'Misused limited access', suspendedUntil: until },
    });
    expect(s.status).toBe(200);
    expect(mocks.setModeration).toHaveBeenLastCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({ status: 'suspended' }),
    );
    const b = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'ban', reason: 'Continued fraud' },
    });
    expect(b.status).toBe(200);
    expect(mocks.setModeration).toHaveBeenLastCalledWith(CUSTOMER_ID, {
      status: 'banned',
      suspendedUntil: null,
    });
  });

  it('allows skipWarning for severe cases only with a reason', async () => {
    mocks.countWarnings.mockResolvedValue(0);
    const r = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'ban', reason: 'Stolen card fraud', skipWarning: true },
    });
    expect(r.status).toBe(200);
    expect(
      (
        await call(`/${CUSTOMER_ID}/sanctions`, {
          method: 'POST',
          body: { action: 'ban', reason: 'x', skipWarning: true },
        })
      ).status,
    ).toBe(400);
  });

  it('validates the suspension end date', async () => {
    mocks.countWarnings.mockResolvedValue(1);
    const post = (body: unknown) => call(`/${CUSTOMER_ID}/sanctions`, { method: 'POST', body });
    expect((await post({ action: 'suspend', reason: 'Fraud pattern' })).status).toBe(400);
    expect(
      (await post({ action: 'suspend', reason: 'Fraud pattern', suspendedUntil: future(-1) }))
        .status,
    ).toBe(400);
    expect(
      (await post({ action: 'suspend', reason: 'Fraud pattern', suspendedUntil: future(400) }))
        .status,
    ).toBe(400);
    expect(
      (await post({ action: 'warning', reason: 'Fraud pattern', suspendedUntil: future(2) }))
        .status,
    ).toBe(400);
  });

  it('lifts a restriction, and refuses to lift an active customer', async () => {
    mocks.customerFindById.mockResolvedValue(
      customerRow({ status: 'suspended', suspendedUntil: new Date(Date.now() + 86_400_000) }),
    );
    const ok = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'lift', reason: 'Appeal accepted' },
    });
    expect(ok.status).toBe(200);
    expect(mocks.setModeration).toHaveBeenLastCalledWith(CUSTOMER_ID, {
      status: 'active',
      suspendedUntil: null,
    });
    mocks.customerFindById.mockResolvedValue(customerRow());
    const bad = await call(`/${CUSTOMER_ID}/sanctions`, {
      method: 'POST',
      body: { action: 'lift', reason: 'Appeal accepted' },
    });
    expect(bad.status).toBe(409);
  });

  it('404s for an unknown customer or a malformed id', async () => {
    mocks.customerFindById.mockResolvedValue(undefined);
    expect(
      (
        await call(`/${CUSTOMER_ID}/sanctions`, {
          method: 'POST',
          body: { action: 'warning', reason: 'Repeated misuse' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('/not-a-uuid/sanctions', {
          method: 'POST',
          body: { action: 'warning', reason: 'Repeated misuse' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('GET /platform/customers/:id', () => {
  it('returns masked detail with history and audits the view', async () => {
    mocks.countWarnings.mockResolvedValue(1);
    const r = await call(`/${CUSTOMER_ID}`);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(FULL_PHONE);
    expect((mocks.auditRecord.mock.calls[0]?.[0] as { action: string }).action).toBe(
      'platform.customer_viewed',
    );
  });
});
