import { Hono } from 'hono';
import { desc, eq, isNull } from 'drizzle-orm';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import { createDb } from '../db/client';
import { b2bParticipations, businesses } from '../db/schema';
import { AppError } from '../lib/errors';
import { ok } from '../lib/response';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables };

/** Read-only platform administration surface; enrollment and moderation writes remain policy-gated. */
export const platformB2bRoutes = new Hono<Env>();
platformB2bRoutes.use('*', authenticate, requirePlatformRole(['admin']));

platformB2bRoutes.get('/participations', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const rawLimit = params.get('limit');
  const rawOffset = params.get('offset');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw new AppError('Invalid pagination.', 400, 'B2B_PAGINATION_INVALID');
  }

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const rows = await db.select({
      businessId: b2bParticipations.businessId,
      businessName: businesses.name,
      businessStatus: businesses.status,
      participationStatus: b2bParticipations.status,
      termsVersionId: b2bParticipations.termsVersionId,
      enrolledAt: b2bParticipations.enrolledAt,
      suspendedAt: b2bParticipations.suspendedAt,
    }).from(b2bParticipations)
      .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
      .where(isNull(businesses.deletedAt))
      .orderBy(desc(b2bParticipations.enrolledAt), b2bParticipations.businessId)
      .limit(limit + 1).offset(offset);
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => ({
      ...row,
      enrolledAt: row.enrolledAt.toISOString(),
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      eligible: row.participationStatus === 'active' && row.businessStatus === 'active',
    }));
    c.header('Cache-Control', 'no-store');
    return ok(c, { data, page: { limit, offset, hasMore } });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

