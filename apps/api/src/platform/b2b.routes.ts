import { Hono } from 'hono';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import { createDb } from '../db/client';
import {
  auditLog,
  b2bAbuseReports,
  b2bMessages,
  b2bModerationActions,
  b2bParticipations,
  b2bPartnerships,
  b2bPartnershipRequests,
  b2bProposals,
  businesses,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { ok } from '../lib/response';
import { parseJsonBody } from '../lib/validate';
import { B2bParticipationService } from '../b2b/b2b-participation.service';

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
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000
  ) {
    throw new AppError('Invalid pagination.', 400, 'B2B_PAGINATION_INVALID');
  }

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const rows = await db
      .select({
        businessId: b2bParticipations.businessId,
        businessName: businesses.name,
        businessStatus: businesses.status,
        participationStatus: b2bParticipations.status,
        termsVersionId: b2bParticipations.termsVersionId,
        enrolledAt: b2bParticipations.enrolledAt,
        suspendedAt: b2bParticipations.suspendedAt,
      })
      .from(b2bParticipations)
      .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
      .where(isNull(businesses.deletedAt))
      .orderBy(desc(b2bParticipations.enrolledAt), b2bParticipations.businessId)
      .limit(limit + 1)
      .offset(offset);
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

platformB2bRoutes.get('/reports', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('offset') ?? 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000
  )
    throw new AppError('Invalid pagination.', 400, 'B2B_PAGINATION_INVALID');
  const status = params.get('status') ?? 'open';
  if (!['open', 'reviewing', 'resolved', 'dismissed', 'all'].includes(status))
    throw new AppError('Invalid report status.', 400, 'B2B_REPORT_STATUS_INVALID');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const where = status === 'all' ? undefined : eq(b2bAbuseReports.status, status);
    const rows = await db
      .select()
      .from(b2bAbuseReports)
      .where(where)
      .orderBy(desc(b2bAbuseReports.createdAt), desc(b2bAbuseReports.id))
      .limit(limit + 1)
      .offset(offset);
    c.header('Cache-Control', 'no-store');
    return ok(c, {
      data: rows.slice(0, limit),
      page: { limit, offset, hasMore: rows.length > limit },
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

platformB2bRoutes.get('/reports/:id', async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const [report] = await db
      .select()
      .from(b2bAbuseReports)
      .where(eq(b2bAbuseReports.id, c.req.param('id')))
      .limit(1);
    if (!report) throw new AppError('Report not found.', 404, 'B2B_REPORT_NOT_FOUND');
    let resource: unknown = null;
    if (report.resourceType === 'message') {
      const [row] = await db
        .select({
          id: b2bMessages.id,
          partnershipId: b2bMessages.partnershipId,
          senderBusinessId: b2bMessages.senderBusinessId,
          body: b2bMessages.body,
          createdAt: b2bMessages.createdAt,
        })
        .from(b2bMessages)
        .innerJoin(b2bPartnerships, eq(b2bPartnerships.id, b2bMessages.partnershipId))
        .where(
          and(
            eq(b2bMessages.id, report.resourceId),
            sql`${report.targetBusinessId} IN (${b2bMessages.senderBusinessId}, ${b2bPartnerships.businessAId}, ${b2bPartnerships.businessBId})`,
          ),
        )
        .limit(1);
      resource = row ?? null;
    } else if (report.resourceType === 'request') {
      const [row] = await db
        .select({
          id: b2bPartnershipRequests.id,
          requesterBusinessId: b2bPartnershipRequests.requesterBusinessId,
          targetBusinessId: b2bPartnershipRequests.targetBusinessId,
          reason: b2bPartnershipRequests.reason,
          status: b2bPartnershipRequests.status,
          createdAt: b2bPartnershipRequests.createdAt,
        })
        .from(b2bPartnershipRequests)
        .where(eq(b2bPartnershipRequests.id, report.resourceId))
        .limit(1);
      resource = row ?? null;
    } else if (report.resourceType === 'proposal') {
      const [row] = await db
        .select({
          id: b2bProposals.id,
          partnershipId: b2bProposals.partnershipId,
          proposerBusinessId: b2bProposals.proposerBusinessId,
          title: b2bProposals.title,
          description: b2bProposals.description,
          status: b2bProposals.status,
          createdAt: b2bProposals.createdAt,
        })
        .from(b2bProposals)
        .where(eq(b2bProposals.id, report.resourceId))
        .limit(1);
      resource = row ?? null;
    }
    c.header('Cache-Control', 'no-store');
    return ok(c, { report, resource });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

const reportReviewSchema = z
  .object({
    status: z.enum(['reviewing', 'resolved', 'dismissed']),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
platformB2bRoutes.post('/reports/:id/review', async (c) => {
  const body = await parseJsonBody(c.req.raw, reportReviewSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const [report] = await db
      .select()
      .from(b2bAbuseReports)
      .where(eq(b2bAbuseReports.id, c.req.param('id')))
      .limit(1);
    if (!report) throw new AppError('Report not found.', 404, 'B2B_REPORT_NOT_FOUND');
    if (report.status === 'resolved' || report.status === 'dismissed')
      throw new AppError('This report is already closed.', 409, 'B2B_REPORT_STATE_CONFLICT');
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(b2bAbuseReports)
        .set({ status: body.status })
        .where(
          and(
            eq(b2bAbuseReports.id, report.id),
            or(eq(b2bAbuseReports.status, 'open'), eq(b2bAbuseReports.status, 'reviewing')),
          ),
        )
        .returning();
      if (!updated)
        throw new AppError(
          'The report changed before review was saved.',
          409,
          'B2B_REPORT_STATE_CONFLICT',
        );
      await tx.insert(auditLog).values({
        businessId: report.targetBusinessId,
        actorUserId: c.get('userId'),
        action: 'b2b.report_reviewed',
        entityType: 'b2b_abuse_report',
        entityId: report.id,
        metadata: {
          status: body.status,
          reason: body.reason,
          reporterBusinessId: report.reporterBusinessId,
        },
      });
      return updated;
    });
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

platformB2bRoutes.get('/moderation/actions', async (c) => {
  const businessId = c.req.query('businessId');
  if (!businessId || !z.string().uuid().safeParse(businessId).success)
    throw new AppError('A valid businessId is required.', 400, 'B2B_MODERATION_FILTER_INVALID');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await db
      .select()
      .from(b2bModerationActions)
      .where(eq(b2bModerationActions.targetBusinessId, businessId))
      .orderBy(desc(b2bModerationActions.createdAt), desc(b2bModerationActions.id))
      .limit(100);
    c.header('Cache-Control', 'no-store');
    return ok(c, { data });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

const moderationReason = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
platformB2bRoutes.post('/participations/:businessId/suspend', async (c) => {
  const body = await parseJsonBody(c.req.raw, moderationReason);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return ok(
      c,
      await new B2bParticipationService(db).suspend({
        businessId: c.req.param('businessId'),
        platformAdminId: c.get('userId'),
        reason: body.reason,
      }),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

platformB2bRoutes.post('/participations/:businessId/reinstate', async (c) => {
  const body = await parseJsonBody(c.req.raw, moderationReason);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return ok(
      c,
      await new B2bParticipationService(db).reinstate({
        businessId: c.req.param('businessId'),
        platformAdminId: c.get('userId'),
        reason: body.reason,
      }),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
