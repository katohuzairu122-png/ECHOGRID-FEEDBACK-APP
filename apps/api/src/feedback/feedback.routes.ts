import { Hono } from 'hono';
import {
  updateFeedbackStatusSchema,
  feedbackFilterSchema,
  assignFeedbackSchema,
  bulkAssignFeedbackSchema,
  bulkUpdateFeedbackStatusSchema,
  type FeedbackFilterInput,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { FeedbackService } from './feedback.service';
import { enqueueClassification } from '../sentiment/sentiment-job';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

export const feedbackRoutes = new Hono<Env>();

/** The business-facing inbox -- every route needs tenant context, same as branchRoutes. */
feedbackRoutes.use('*', authenticate, resolveTenantContext);

/**
 * Builds feedbackFilterSchema's raw input from a query string -- hand-rolled
 * rather than a generic query-parsing helper, since this is the one route
 * in the codebase with a filter surface this wide (every other GET route's
 * query parsing stays a handful of ad hoc `.get()` calls). Multi-select
 * fields accept repeated keys (?urgency=P0_CRITICAL&urgency=P1_HIGH), the
 * REST convention `URLSearchParams.getAll` already supports natively.
 */
function parseFeedbackFilters(url: URL): FeedbackFilterInput {
  const params = url.searchParams;
  const raw: Record<string, unknown> = {};
  if (params.has('savedView')) raw.savedView = params.get('savedView');
  if (params.has('branchId')) raw.branchId = params.get('branchId');
  if (params.has('category')) raw.category = params.getAll('category');
  if (params.has('urgency')) raw.urgency = params.getAll('urgency');
  if (params.has('sentiment')) raw.sentiment = params.getAll('sentiment');
  if (params.has('status')) raw.status = params.getAll('status');
  if (params.has('analysisStatus')) raw.analysisStatus = params.getAll('analysisStatus');
  if (params.has('assignedTo')) raw.assignedTo = params.get('assignedTo');
  if (params.has('unassigned')) raw.unassigned = params.get('unassigned') === 'true';
  if (params.has('followUpRequired')) raw.followUpRequired = params.get('followUpRequired') === 'true';
  if (params.has('search')) raw.search = params.get('search');
  if (params.has('dateFrom')) raw.dateFrom = params.get('dateFrom');
  if (params.has('dateTo')) raw.dateTo = params.get('dateTo');
  if (params.has('sortBy')) raw.sortBy = params.get('sortBy');
  if (params.has('sortDirection')) raw.sortDirection = params.get('sortDirection');
  if (params.has('limit')) raw.limit = Number(params.get('limit'));
  if (params.has('offset')) raw.offset = Number(params.get('offset'));

  const parsed = feedbackFilterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('Invalid filter parameters.', 400, 'VALIDATION_ERROR', parsed.error.issues);
  }
  return parsed.data;
}

feedbackRoutes.get('/', requirePermission('feedback:view'), async (c) => {
  const filters = parseFeedbackFilters(new URL(c.req.url));
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    const result = await service.listWithFilters(c.get('businessId'), filters);
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

feedbackRoutes.post('/:id/assign', requirePermission('feedback:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, assignFeedbackSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    const item = await service.assign(c.req.param('id'), c.get('businessId'), body.assignedTo, c.get('userId'));

    c.set('auditMetadata', {
      action: 'feedback.assigned',
      entityType: 'feedback',
      entityId: item.id,
      details: { assignedTo: body.assignedTo },
    });

    return ok(c, item);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

feedbackRoutes.post('/bulk/assign', requirePermission('feedback:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, bulkAssignFeedbackSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    const items = await service.bulkAssign(body.feedbackIds, c.get('businessId'), body.assignedTo, c.get('userId'));

    c.set('auditMetadata', {
      action: 'feedback.bulk_assigned',
      entityType: 'feedback',
      details: { requested: body.feedbackIds.length, updated: items.length, assignedTo: body.assignedTo },
    });

    return ok(c, { updated: items.length, items });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

feedbackRoutes.post('/bulk/status', requirePermission('feedback:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, bulkUpdateFeedbackStatusSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    const items = await service.bulkMarkReviewed(body.feedbackIds, c.get('businessId'), c.get('userId'));

    c.set('auditMetadata', {
      action: 'feedback.bulk_reviewed',
      entityType: 'feedback',
      details: { requested: body.feedbackIds.length, updated: items.length },
    });

    return ok(c, { updated: items.length, items });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Narrow on purpose -- updateFeedbackStatusSchema only accepts
 * {status: 'reviewed'}. A business can acknowledge feedback, never edit a
 * customer's actual rating/comment.
 */
feedbackRoutes.patch('/:id', requirePermission('feedback:manage'), async (c) => {
  await parseJsonBody(c.req.raw, updateFeedbackStatusSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    const item = await service.markReviewed(c.req.param('id'), c.get('businessId'), c.get('userId'));

    c.set('auditMetadata', {
      action: 'feedback.reviewed',
      entityType: 'feedback',
      entityId: item.id,
    });

    return ok(c, item);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Manual retry for a row stuck at analysisStatus='failed' (or to re-run a
 * 'completed' one after a model change) -- gated by the existing
 * feedback:manage permission rather than a new one, since triaging a
 * feedback submission's analysis state is the same supervisory action as
 * marking it reviewed, not a distinct capability. No new `analytics:view`
 * permission exists yet; that ships with the analytics dashboard API
 * (Block 4), where "viewing sentiment analytics" becomes a real, separate
 * screen worth gating on its own.
 */
feedbackRoutes.post('/:id/reanalyze', requirePermission('feedback:manage'), async (c) => {
  const id = c.req.param('id');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const existing = await createRepositories(db).feedback.findById(id, c.get('businessId'));
    if (!existing) {
      throw new AppError('Feedback not found.', 404, 'FEEDBACK_NOT_FOUND');
    }
    await enqueueClassification(c.env.JOBS, existing.id, existing.businessId);
    return ok(c, { id: existing.id, analysisStatus: existing.analysisStatus }, 202);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Stops the escalation clock on a P0_CRITICAL incident -- gated on
 * feedback:manage, the same permission the critical alert itself is
 * filtered to (only someone who could have received the alert can silence
 * it). 404s both when the feedback row doesn't exist for this tenant AND
 * when it exists but was never flagged critical -- either way there is no
 * incident to acknowledge, and the two cases shouldn't be distinguishable
 * to the caller (no reason to leak "that id exists but isn't critical").
 */
feedbackRoutes.post('/:id/acknowledge-critical', requirePermission('feedback:manage'), async (c) => {
  const feedbackId = c.req.param('id');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const incident = await repos.criticalIncidents.findByFeedbackId(feedbackId, c.get('businessId'));
    if (!incident) {
      throw new AppError('No critical incident found for this feedback.', 404, 'CRITICAL_INCIDENT_NOT_FOUND');
    }
    const acknowledged = await repos.criticalIncidents.acknowledge(incident.id, c.get('businessId'), c.get('userId'));

    c.set('auditMetadata', {
      action: 'feedback.critical_incident_acknowledged',
      entityType: 'critical_incident',
      entityId: incident.id,
    });

    // acknowledged is undefined if it was already acknowledged (the WHERE
    // acknowledgedAt IS NULL guard didn't match) -- not an error, return the
    // already-acknowledged row so a retried/double-clicked request is still
    // a 200 with the real current state, not a spurious failure.
    return ok(c, acknowledged ?? incident);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

feedbackRoutes.delete('/:id', requirePermission('feedback:manage'), async (c) => {
  const id = c.req.param('id');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    await service.remove(id, c.get('businessId'), c.get('userId'));

    c.set('auditMetadata', {
      action: 'feedback.removed',
      entityType: 'feedback',
      entityId: id,
    });

    return c.body(null, 204);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
