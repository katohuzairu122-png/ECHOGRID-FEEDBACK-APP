import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import { resolveTenantContext, type TenantVariables } from './tenant-context';
import { requirePermission } from './require-permission';
import { requireAuthorizedBranchParam, requireBusinessWideAccess } from './require-business-wide-access';
import { AppError } from '../lib/errors';

const mocks = vi.hoisted(() => ({
  membership: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  permissions: vi.fn(),
  write: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    userBusinessRoles: { listForUserAtBusiness: mocks.membership },
    businesses: { findById: mocks.business },
    branches: { findById: mocks.branch },
    permissions: { findEffectiveKeys: mocks.permissions },
  })),
}));

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };

function makeApp() {
  const app = new Hono<Env>();
  // An authenticated identity supplied by the fixture; membership and
  // effective privileges still come exclusively from the mocked DB.
  app.use('*', async (c, next) => {
    c.set('userId', 'staff-a');
    await next();
  });
  app.use('*', resolveTenantContext);
  app.get('/read', requirePermission('loyalty:view'), (c) =>
    c.json({ businessId: c.get('businessId'), branchId: c.get('branchId') ?? null }),
  );
  app.post('/write', requireBusinessWideAccess, requirePermission('loyalty:manage'), (c) => {
    mocks.write();
    return c.json({ accepted: true });
  });
  app.get('/branches/:id', requireAuthorizedBranchParam(), requirePermission('branches:view'), (c) =>
    c.json({ branchId: c.req.param('id'), businessId: c.get('businessId') }),
  );
  app.onError((err, c) =>
    c.json({ code: err instanceof AppError ? err.code : 'UNEXPECTED' }, err instanceof AppError ? err.status : 500),
  );
  return app;
}

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function request(
  path: string,
  businessId: string,
  branchId?: string,
  method: 'GET' | 'POST' = 'GET',
) {
  return makeApp().request(path, {
    method,
    headers: {
      'X-Business-Id': businessId,
      ...(branchId === undefined ? {} : { 'X-Branch-Id': branchId }),
    },
  }, {} as Bindings, executionCtx());
}

describe('DEV-52 cross-tenant and branch security regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membership.mockImplementation(async (_userId: string, businessId: string) =>
      businessId === 'business-a' || businessId === 'business-b'
        ? [{ branchId: null }]
        : [],
    );
    mocks.business.mockResolvedValue({ status: 'active' });
    mocks.branch.mockImplementation(async (branchId: string, businessId: string) =>
      (branchId === 'branch-a' && businessId === 'business-a') ||
      (branchId === 'branch-b' && businessId === 'business-b')
        ? { id: branchId, businessId }
        : undefined,
    );
    mocks.permissions.mockImplementation(async (_userId: string, businessId: string) =>
      businessId === 'business-a'
        ? new Set(['loyalty:view', 'loyalty:manage', 'branches:view'])
        : new Set(['branches:view']),
    );
  });

  it('resolves the permission set separately for each business and never reuses a previous request grant', async () => {
    const allowed = await request('/read', 'business-a');
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ businessId: 'business-a', branchId: null });

    const denied = await request('/read', 'business-b');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'PERMISSION_DENIED' });
    expect(mocks.permissions).toHaveBeenNthCalledWith(1, 'staff-a', 'business-a', undefined);
    expect(mocks.permissions).toHaveBeenNthCalledWith(2, 'staff-a', 'business-b', undefined);
  });

  it('does not reveal target business state or resolve permissions for nonmembers', async () => {
    mocks.business.mockResolvedValue({ status: 'suspended' });
    const denied = await request('/read', 'business-foreign');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'NOT_A_MEMBER' });
    expect(mocks.business).not.toHaveBeenCalled();
    expect(mocks.permissions).not.toHaveBeenCalled();
  });

  it('denies suspended businesses after membership is proven but before permissions are granted', async () => {
    mocks.business.mockResolvedValue({ status: 'suspended' });
    const denied = await request('/read', 'business-a');
    expect(denied.status).toBe(403);
    expect(mocks.membership).toHaveBeenCalledWith('staff-a', 'business-a');
    expect(mocks.permissions).not.toHaveBeenCalled();
  });

  it('rejects a foreign branch selector for a business-wide member before computing permissions', async () => {
    const denied = await request('/branches/branch-b', 'business-a', 'branch-b');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'BRANCH_ACCESS_DENIED' });
    expect(mocks.branch).toHaveBeenCalledWith('branch-b', 'business-a');
    expect(mocks.permissions).not.toHaveBeenCalled();
  });

  it('denies a branch-scoped user requesting another branch before it reaches permission checks', async () => {
    mocks.membership.mockResolvedValue([{ branchId: 'branch-a' }]);
    const denied = await request('/branches/branch-b', 'business-a', 'branch-b');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'BRANCH_ACCESS_DENIED' });
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('requires the correct branch selector for a branch-scoped user', async () => {
    mocks.membership.mockResolvedValue([{ branchId: 'branch-a' }]);
    const missing = await request('/read', 'business-a');
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ code: 'BRANCH_CONTEXT_REQUIRED' });
    const valid = await request('/read', 'business-a', 'branch-a');
    expect(valid.status).toBe(200);
    expect(mocks.permissions).toHaveBeenCalledWith('staff-a', 'business-a', 'branch-a');
  });

  it('never allows a branch-scoped user to perform a business-wide mutation', async () => {
    mocks.membership.mockResolvedValue([{ branchId: 'branch-a' }]);
    const denied = await request('/write', 'business-a', 'branch-a', 'POST');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'BUSINESS_WIDE_ACCESS_REQUIRED' });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('keeps business-wide mutation authority dependent on each business permission set', async () => {
    const allowed = await request('/write', 'business-a', undefined, 'POST');
    expect(allowed.status).toBe(200);
    const denied = await request('/write', 'business-b', undefined, 'POST');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'PERMISSION_DENIED' });
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
});
