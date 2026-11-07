import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { requirePermission } from './require-permission';
import { requireAuthorizedBranchParam, requireBusinessWideAccess } from './require-business-wide-access';
import { AppError } from '../lib/errors';

type GuardContext = Partial<AuthVariables & TenantVariables>;
type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };

function guardApp(context: GuardContext) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (context.userId !== undefined) c.set('userId', context.userId);
    if (context.businessId !== undefined) c.set('businessId', context.businessId);
    if (context.branchId !== undefined) c.set('branchId', context.branchId);
    if (context.businessWideAccess !== undefined) c.set('businessWideAccess', context.businessWideAccess);
    if (context.permissions !== undefined) c.set('permissions', context.permissions);
    await next();
  });
  app.get('/permission', requirePermission('loyalty:view'), (c) => c.json({ granted: true }));
  app.get('/wide', requireBusinessWideAccess, (c) => c.json({ granted: true }));
  app.get('/branches/:id', requireAuthorizedBranchParam(), (c) => c.json({ id: c.req.param('id') }));
  app.onError((err, c) =>
    c.json({ code: err instanceof AppError ? err.code : 'UNEXPECTED' }, err instanceof AppError ? err.status : 500),
  );
  return app;
}

const wide = {
  userId: 'staff-a', businessId: 'business-a',
  businessWideAccess: true, permissions: new Set(['loyalty:view']),
} satisfies GuardContext;
const scoped = {
  ...wide, businessWideAccess: false, branchId: 'branch-a',
} satisfies GuardContext;

describe('DEV-50 fail-closed tenant authorization guards', () => {
  it.each([
    {},
    { permissions: new Set(['loyalty:view']) },
    { userId: 'staff-a', businessId: 'business-a', businessWideAccess: true },
    { userId: 'staff-a', businessWideAccess: true, permissions: new Set(['loyalty:view']) },
    { businessId: 'business-a', businessWideAccess: true, permissions: new Set(['loyalty:view']) },
    { userId: 'staff-a', businessId: 'business-a', permissions: new Set(['loyalty:view']) },
    { userId: 'staff-a', businessId: 'business-a', businessWideAccess: false, permissions: new Set(['loyalty:view']) },
  ])('denies missing authorization context before permission-based handler execution %#', async (ctx) => {
    const response = await guardApp(ctx).request('/permission');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'TENANT_CONTEXT_UNAVAILABLE' });
  });

  it('accepts correctly resolved context with the required permission', async () => {
    expect((await guardApp(wide).request('/permission')).status).toBe(200);
    expect((await guardApp(scoped).request('/permission')).status).toBe(200);
  });

  it('denies a missing permission after trusted context has been established', async () => {
    const response = await guardApp({ ...wide, permissions: new Set() }).request('/permission');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'PERMISSION_DENIED' });
  });

  it('denies business-wide operations when context is missing or scoped to one branch', async () => {
    const missing = await guardApp({ permissions: new Set() }).request('/wide');
    expect(await missing.json()).toEqual({ code: 'TENANT_CONTEXT_UNAVAILABLE' });
    const scopedResponse = await guardApp(scoped).request('/wide');
    expect(await scopedResponse.json()).toEqual({ code: 'BUSINESS_WIDE_ACCESS_REQUIRED' });
    expect((await guardApp(wide).request('/wide')).status).toBe(200);
  });

  it('denies branch-parameter routes without tenant context', async () => {
    const response = await guardApp({ permissions: new Set() }).request('/branches/branch-a');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'TENANT_CONTEXT_UNAVAILABLE' });
  });

  it('does not allow a branch-scoped user to use another branch id', async () => {
    const response = await guardApp(scoped).request('/branches/branch-b');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'BUSINESS_WIDE_ACCESS_REQUIRED' });
    expect((await guardApp(scoped).request('/branches/branch-a')).status).toBe(200);
    expect((await guardApp(wide).request('/branches/branch-b')).status).toBe(200);
  });
});
