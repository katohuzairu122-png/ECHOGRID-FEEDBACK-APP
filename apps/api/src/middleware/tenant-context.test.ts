import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { resolveTenantContext } from './tenant-context';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { AppError } from '../lib/errors';

const mocks = vi.hoisted(() => ({
  membership: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  permissions: vi.fn(),
}));
vi.mock('../db/client', () => ({ createDb: async () => ({ db: {}, close: async () => {} }) }));
vi.mock('../repositories', () => ({
  createRepositories: () => ({
    userBusinessRoles: { listForUserAtBusiness: mocks.membership },
    businesses: { findById: mocks.business },
    branches: { findById: mocks.branch },
    permissions: { findEffectiveKeys: mocks.permissions },
  }),
}));

function app() {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables & TenantVariables }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'staff');
    await next();
  });
  app.use('*', resolveTenantContext);
  app.onError((err, c) => c.json({ code: err instanceof AppError ? err.code : 'UNEXPECTED' }, 403));
  app.get('/', (c) =>
    c.json({ businessId: c.get('businessId'), branchId: c.get('branchId') ?? null }),
  );
  return app;
}
async function request(headers: Record<string, string>) {
  return app().fetch(new Request('https://example.test/', { headers }), {} as Bindings, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue([{ branchId: null }]);
  mocks.business.mockResolvedValue({ status: 'active' });
  mocks.branch.mockResolvedValue({ id: 'branch-a', businessId: 'business-a' });
  mocks.permissions.mockResolvedValue(new Set(['loyalty:view', 'settlement:view']));
});
describe('trusted QR and settlement tenant context', () => {
  it('rejects a foreign branch even for a business-wide role before resolving permissions', async () => {
    mocks.branch.mockResolvedValue(undefined);
    const response = await request({
      'X-Business-Id': 'business-a',
      'X-Branch-Id': 'foreign-branch',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'BRANCH_ACCESS_DENIED' });
    expect(mocks.branch).toHaveBeenCalledWith('foreign-branch', 'business-a');
    expect(mocks.permissions).not.toHaveBeenCalled();
  });
  it('accepts a branch verified within the active business', async () => {
    const response = await request({ 'X-Business-Id': 'business-a', 'X-Branch-Id': 'branch-a' });
    expect(response.status).toBe(200);
    expect(mocks.permissions).toHaveBeenCalledWith('staff', 'business-a', 'branch-a');
  });
  it('requires a branch for a branch-scoped grant', async () => {
    mocks.membership.mockResolvedValue([{ branchId: 'branch-a' }]);
    const response = await request({ 'X-Business-Id': 'business-a' });
    expect(await response.json()).toEqual({ code: 'BRANCH_CONTEXT_REQUIRED' });
    expect(mocks.permissions).not.toHaveBeenCalled();
  });
  it('denies another branch outside a staff grant', async () => {
    mocks.membership.mockResolvedValue([{ branchId: 'branch-a' }]);
    const response = await request({ 'X-Business-Id': 'business-a', 'X-Branch-Id': 'branch-b' });
    expect(await response.json()).toEqual({ code: 'BRANCH_ACCESS_DENIED' });
  });
  it('does not reveal business status to a non-member', async () => {
    mocks.membership.mockResolvedValue([]);
    const response = await request({ 'X-Business-Id': 'foreign-business' });
    expect(await response.json()).toEqual({ code: 'NOT_A_MEMBER' });
    expect(mocks.business).not.toHaveBeenCalled();
  });
});
