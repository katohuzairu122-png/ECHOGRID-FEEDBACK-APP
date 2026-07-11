import { Hono } from 'hono';
import { updateFeedbackStatusSchema } from '@echo-grid-feedback/shared-types';
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

feedbackRoutes.get('/', requirePermission('feedback:view'), async (c) => {
  const url = new URL(c.req.url);
  const branchId = url.searchParams.get('branchId') ?? undefined;
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new FeedbackService(createRepositories(db));
    const items = await service.listForBusiness(c.get('businessId'), { branchId, limit, offset });
    return ok(c, items);
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
