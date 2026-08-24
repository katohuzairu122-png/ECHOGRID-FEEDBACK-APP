import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import type { FraudSignal } from '../repositories/fraud-signal.repository';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

/**
 * Minimal S7.1 manual-review surface (Continuing Development Block 5.1).
 * FraudSignalRepository (listOpenForBusiness, markReviewed, markDismissed)
 * has been fully built since Block 3.1, explicitly ahead of any consumer --
 * see that repository's own doc comment. This is the first route to read
 * from it; fraud_signals has been accumulating real rows since Block 3.1
 * (QR-token rejection), 4.1 (velocity/cooldown), and 4.3.2 (visit
 * verification) with no way for staff to see any of them until now.
 *
 * Top-level /fraud-signals, not nested under /branches -- a business's
 * signals span every branch, matching how loyaltyRoutes/analyticsRoutes
 * mount at their own top-level prefix rather than nesting under branches
 * the way QR codes and visit sessions (genuinely single-branch resources) do.
 *
 * Gated by feedback:manage -- reused, not a new permission key, matching
 * how critical-incident alerts already gate on this same key for a similar
 * trust-and-safety concern. A dedicated fraud:* permission is a clean
 * future refinement if finer-grained control is ever needed.
 */
export const fraudSignalRoutes = new Hono<Env>();

fraudSignalRoutes.use('*', authenticate, resolveTenantContext);

function serializeFraudSignal(signal: FraudSignal) {
  return {
    id: signal.id,
    businessId: signal.businessId,
    branchId: signal.branchId,
    feedbackId: signal.feedbackId,
    signalType: signal.signalType,
    reasonCode: signal.reasonCode,
    severity: signal.severity,
    status: signal.status,
    metadata: signal.metadata,
    detectedAt: signal.detectedAt.toISOString(),
    reviewedAt: signal.reviewedAt ? signal.reviewedAt.toISOString() : null,
    reviewedBy: signal.reviewedBy,
  };
}

fraudSignalRoutes.get('/', requirePermission('feedback:manage'), async (c) => {
  const url = new URL(c.req.url);
  const branchId = url.searchParams.get('branchId') ?? undefined;
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const signals = await createRepositories(db).fraudSignals.listOpenForBusiness(c.get('businessId'), {
      branchId,
      limit,
      offset,
    });
    return ok(c, signals.map(serializeFraudSignal));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Shared by /review and /dismiss -- both are "confirm the signal exists
 * under this tenant, then attempt the one-way status flip" with only the
 * repository method and audit action differing.
 *
 * markFn returning undefined means the signal is no longer 'open' -- a
 * double-click, a retried request, or two staff racing the same signal, per
 * FraudSignalRepository's own doc comment on why this is a guarded one-way
 * flip rather than a free-for-all update. Falls back to the row already
 * confirmed by findById, so a repeat action is idempotent (same response
 * shape either way) instead of surfacing a confusing failure for something
 * that already happened.
 */
async function respondWithReviewAction(
  c: Context<Env>,
  markFn: (
    repos: ReturnType<typeof createRepositories>,
    id: string,
    businessId: string,
    actorId: string,
  ) => Promise<FraudSignal | undefined>,
  auditAction: string,
) {
  const id = c.req.param('id');
  const businessId = c.get('businessId');

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const existing = await repos.fraudSignals.findById(id, businessId);
    if (!existing) {
      throw new AppError('Fraud signal not found.', 404, 'FRAUD_SIGNAL_NOT_FOUND');
    }

    const result = (await markFn(repos, id, businessId, c.get('userId'))) ?? existing;

    c.set('auditMetadata', { action: auditAction, entityType: 'fraud_signal', entityId: id });

    return ok(c, serializeFraudSignal(result));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

fraudSignalRoutes.post('/:id/review', requirePermission('feedback:manage'), (c) =>
  respondWithReviewAction(
    c,
    (repos, id, businessId, actorId) => repos.fraudSignals.markReviewed(id, businessId, actorId),
    'fraud_signal.reviewed',
  ),
);

fraudSignalRoutes.post('/:id/dismiss', requirePermission('feedback:manage'), (c) =>
  respondWithReviewAction(
    c,
    (repos, id, businessId, actorId) => repos.fraudSignals.markDismissed(id, businessId, actorId),
    'fraud_signal.dismissed',
  ),
);
