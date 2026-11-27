import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { createDb } from '../db/client';
import { b2bParticipations } from '../db/schema';
import { ok } from '../lib/response';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };

/**
 * Split 09 participation read surface. This exposes only the caller's own
 * business enrollment state. Participation remains unavailable until the
 * platform has an active terms version and the business has completed the
 * approved acceptance and enrollment flow; this route cannot change state.
 */
export const b2bRoutes = new Hono<Env>();

b2bRoutes.get('/participation', authenticate, resolveTenantContext, requireBusinessWideAccess, async (c) => {
  const businessId = c.get('businessId');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const row = await db.query.b2bParticipations.findFirst({ where: eq(b2bParticipations.businessId, businessId) });
    c.header('Cache-Control', 'no-store');
    return ok(c, row ? {
      businessId,
      status: row.status,
      termsVersionId: row.termsVersionId,
      enrolledAt: row.enrolledAt.toISOString(),
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
    } : { businessId, status: 'not_enrolled' as const, termsVersionId: null, enrolledAt: null, suspendedAt: null });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
