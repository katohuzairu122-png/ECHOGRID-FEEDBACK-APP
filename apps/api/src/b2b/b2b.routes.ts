import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { requirePermission } from '../middleware/require-permission';
import { createDb } from '../db/client';
import { b2bParticipations, businessPublicProfiles, businesses } from '../db/schema';
import { ok } from '../lib/response';
import { parseJsonBody } from '../lib/validate';
import { parseListPagination } from '../lib/list-pagination';
import { AppError } from '../lib/errors';
import { B2bNetworkService } from './b2b-network.service';
import { B2bActivitiesService } from './b2b-activities.service';
import { B2bDiscoveryService } from './b2b-discovery.service';
import { B2bParticipationService } from './b2b-participation.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };

/**
 * Split 09 participation read surface. This exposes only the caller's own
 * business enrollment state. Participation remains unavailable until the
 * platform has an active terms version and the business has completed the
 * approved acceptance and enrollment flow; this route cannot change state.
 */
export const b2bRoutes = new Hono<Env>();

b2bRoutes.use('*', authenticate, resolveTenantContext, requireBusinessWideAccess);

b2bRoutes.get('/participation', requirePermission('b2b:view'), async (c) => {
  const businessId = c.get('businessId');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const row = await db.query.b2bParticipations.findFirst({
      where: eq(b2bParticipations.businessId, businessId),
    });
    c.header('Cache-Control', 'no-store');
    return ok(
      c,
      row
        ? {
            businessId,
            status: row.status,
            termsVersionId: row.termsVersionId,
            enrolledAt: row.enrolledAt.toISOString(),
            suspendedAt: row.suspendedAt?.toISOString() ?? null,
          }
        : {
            businessId,
            status: 'not_enrolled' as const,
            termsVersionId: null,
            enrolledAt: null,
            suspendedAt: null,
          },
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/participation/withdraw', requirePermission('b2b:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bParticipationService(db).withdraw({
      businessId: c.get('businessId'),
      actorUserId: c.get('userId'),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, {
      businessId: result.businessId,
      status: result.status,
      withdrawnAt: result.withdrawnAt?.toISOString() ?? null,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/directory', requirePermission('b2b:view'), async (c) => {
  const params = new URL(c.req.url).searchParams;
  const pagination = parseListPagination(params, 100);
  const query = params.get('q')?.trim();
  const categoryId = params.get('categoryId') ?? undefined;
  const city = params.get('city')?.trim() ?? undefined;
  const region = params.get('region')?.trim() ?? undefined;
  const countryCode = params.get('countryCode')?.toUpperCase() ?? undefined;
  if (
    (query && query.length > 80) ||
    (city && city.length > 80) ||
    (region && region.length > 80) ||
    (categoryId && !z.string().uuid().safeParse(categoryId).success) ||
    (countryCode && !/^[A-Z]{2}$/.test(countryCode))
  ) {
    throw new AppError('Invalid business discovery filter.', 400, 'B2B_DISCOVERY_FILTER_INVALID');
  }
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bDiscoveryService(db).search({
      businessId: c.get('businessId'),
      limit: pagination.limit ?? 50,
      offset: pagination.offset ?? 0,
      ...(query ? { query } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(city ? { city } : {}),
      ...(region ? { region } : {}),
      ...(countryCode ? { countryCode } : {}),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/directory/:handle', requirePermission('b2b:view'), async (c) => {
  const handle = c.req.param('handle');
  if (!/^[A-Za-z0-9_-]{22}$/.test(handle))
    throw new AppError('Business profile not found.', 404, 'B2B_NOT_FOUND');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const profile = await new B2bDiscoveryService(db).profile({
      businessId: c.get('businessId'),
      handle,
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, profile);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

const requestSchema = z
  .object({
    targetHandle: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
const responseSchema = z
  .object({ note: z.string().trim().max(500).nullable().optional() })
  .strict();

b2bRoutes.post('/partnership-requests', requirePermission('b2b:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, requestSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const [target] = await db
      .select({ businessId: businesses.id })
      .from(businessPublicProfiles)
      .innerJoin(businesses, eq(businesses.id, businessPublicProfiles.businessId))
      .innerJoin(b2bParticipations, eq(b2bParticipations.businessId, businesses.id))
      .where(
        and(
          eq(businessPublicProfiles.profileHandle, body.targetHandle),
          eq(businessPublicProfiles.publicationState, 'published'),
          eq(b2bParticipations.status, 'active'),
          eq(businesses.status, 'active'),
          isNull(businesses.deletedAt),
        ),
      )
      .limit(1);
    if (!target) {
      throw new AppError('Eligible business not found.', 404, 'B2B_NOT_FOUND');
    }
    const service = new B2bNetworkService(db);
    const request = await service.createRequest({
      requesterBusinessId: c.get('businessId'),
      targetBusinessId: target.businessId,
      actorUserId: c.get('userId'),
      idempotencyKey: c.req.header('Idempotency-Key') ?? '',
      reason: body.reason,
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, request, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

for (const direction of ['incoming', 'outgoing'] as const) {
  b2bRoutes.get(`/partnership-requests/${direction}`, requirePermission('b2b:view'), async (c) => {
    const pagination = parseListPagination(new URL(c.req.url).searchParams, 100);
    const limit = pagination.limit ?? 50;
    const offset = pagination.offset ?? 0;
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const data = await new B2bNetworkService(db).listRequests(c.get('businessId'), direction, {
        limit,
        offset,
      });
      c.header('Cache-Control', 'no-store');
      return ok(c, { data, page: { limit, offset } });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  });
}

b2bRoutes.post('/partnership-requests/:id/accept', requirePermission('b2b:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, responseSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bNetworkService(db).respond({
      businessId: c.get('businessId'),
      actorUserId: c.get('userId'),
      requestId: c.req.param('id'),
      outcome: 'accepted',
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/partnership-requests/:id/reject', requirePermission('b2b:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, responseSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bNetworkService(db).respond({
      businessId: c.get('businessId'),
      actorUserId: c.get('userId'),
      requestId: c.req.param('id'),
      outcome: 'rejected',
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, result.request);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/partnership-requests/:id/cancel', requirePermission('b2b:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bNetworkService(db).cancel({
      businessId: c.get('businessId'),
      actorUserId: c.get('userId'),
      requestId: c.req.param('id'),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/partnerships', requirePermission('b2b:view'), async (c) => {
  const pagination = parseListPagination(new URL(c.req.url).searchParams, 100);
  const limit = pagination.limit ?? 50;
  const offset = pagination.offset ?? 0;
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bNetworkService(db).listPartnerships(c.get('businessId'), {
      limit,
      offset,
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, { data, page: { limit, offset } });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/partnership-requests/:id/history', requirePermission('b2b:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bNetworkService(db).requestHistory(
      c.get('businessId'),
      c.req.param('id'),
    );
    c.header('Cache-Control', 'no-store');
    return ok(c, data);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/partnerships/:id/terminate', requirePermission('b2b:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bNetworkService(db).terminate({
      businessId: c.get('businessId'),
      actorUserId: c.get('userId'),
      partnershipId: c.req.param('id'),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/partnerships/:id/history', requirePermission('b2b:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bNetworkService(db).partnershipHistory(
      c.get('businessId'),
      c.req.param('id'),
    );
    c.header('Cache-Control', 'no-store');
    return ok(c, data);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
const proposalSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
  })
  .strict();
const reportSchema = z
  .object({
    targetBusinessId: z.string().uuid(),
    resourceType: z.enum(['business', 'request', 'partnership', 'message', 'proposal']),
    resourceId: z.string().uuid(),
    reasonCode: z.enum([
      'spam',
      'harassment',
      'misrepresentation',
      'unauthorized_content',
      'other',
    ]),
    details: z.string().max(1000).nullable().optional(),
  })
  .strict();

b2bRoutes.get('/notifications', requirePermission('b2b:view'), async (c) => {
  const pagination = parseListPagination(new URL(c.req.url).searchParams, 100);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bActivitiesService(db).listNotifications(
      c.get('businessId'),
      c.get('userId'),
      pagination.limit ?? 50,
    );
    c.header('Cache-Control', 'no-store');
    return ok(c, { data });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/unread', requirePermission('b2b:message'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bActivitiesService(db).unreadMessageCounts(
      c.get('businessId'),
      c.get('userId'),
    );
    c.header('Cache-Control', 'no-store');
    return ok(c, { data });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/notifications/:id/read', requirePermission('b2b:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new B2bActivitiesService(db).markNotificationRead({
      businessId: c.get('businessId'),
      userId: c.get('userId'),
      notificationId: c.req.param('id'),
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/partnerships/:id/messages', requirePermission('b2b:message'), async (c) => {
  const pagination = parseListPagination(new URL(c.req.url).searchParams, 100);
  const before = new URL(c.req.url).searchParams.get('before') ?? undefined;
  if (before && Number.isNaN(Date.parse(before)))
    throw new AppError('Invalid message cursor.', 400, 'B2B_CURSOR_INVALID');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new B2bActivitiesService(db);
    const data = await service.listMessages({
      businessId: c.get('businessId'),
      userId: c.get('userId'),
      partnershipId: c.req.param('id'),
      limit: pagination.limit ?? 50,
      ...(before ? { before } : {}),
    });
    const unread = await service.unreadMessageCounts(c.get('businessId'), c.get('userId'));
    c.header('Cache-Control', 'no-store');
    return ok(c, { data, unread });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/partnerships/:id/messages', requirePermission('b2b:message'), async (c) => {
  const body = await parseJsonBody(c.req.raw, messageSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bActivitiesService(db).sendMessage({
      businessId: c.get('businessId'),
      userId: c.get('userId'),
      partnershipId: c.req.param('id'),
      body: body.body,
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, data, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.get('/partnerships/:id/proposals', requirePermission('b2b:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bActivitiesService(db).listProposals(
      c.get('businessId'),
      c.req.param('id'),
    );
    c.header('Cache-Control', 'no-store');
    return ok(c, { data });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/partnerships/:id/proposals', requirePermission('b2b:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, proposalSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bActivitiesService(db).createProposal({
      businessId: c.get('businessId'),
      userId: c.get('userId'),
      partnershipId: c.req.param('id'),
      title: body.title,
      description: body.description,
    });
    c.header('Cache-Control', 'no-store');
    return ok(c, data, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/proposals/:id/accept', requirePermission('b2b:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return ok(
      c,
      await new B2bActivitiesService(db).respondProposal({
        businessId: c.get('businessId'),
        userId: c.get('userId'),
        proposalId: c.req.param('id'),
        outcome: 'accepted',
      }),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/proposals/:id/decline', requirePermission('b2b:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return ok(
      c,
      await new B2bActivitiesService(db).respondProposal({
        businessId: c.get('businessId'),
        userId: c.get('userId'),
        proposalId: c.req.param('id'),
        outcome: 'declined',
      }),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/proposals/:id/withdraw', requirePermission('b2b:manage'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return ok(
      c,
      await new B2bActivitiesService(db).withdrawProposal({
        businessId: c.get('businessId'),
        userId: c.get('userId'),
        proposalId: c.req.param('id'),
      }),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

b2bRoutes.post('/reports', requirePermission('b2b:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, reportSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const data = await new B2bActivitiesService(db).report({
      businessId: c.get('businessId'),
      userId: c.get('userId'),
      targetBusinessId: body.targetBusinessId,
      resourceType: body.resourceType,
      resourceId: body.resourceId,
      reasonCode: body.reasonCode,
      ...(body.details === undefined ? {} : { details: body.details }),
    });
    return ok(c, data, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
