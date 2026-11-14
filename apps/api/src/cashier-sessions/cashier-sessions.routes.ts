import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import type { AuditVariables } from '../middleware/audit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };

/**
 * CASHIER-PWA-01 C6: business-scoped management of cashier sessions.
 *
 * These are ORDINARY staff routes (web token + X-Business-Id). They are deliberately not on the cashier token's
 * allow-list, so a cashier session can never list or revoke sessions. Every query is pinned to the business that
 * resolveTenantContext proved the caller belongs to, so there is no cross-business enumeration or revocation, and
 * only rows with client = 'cashier' are touched, so web (business-admin) sessions are never affected.
 *
 * Permission: `business:manage_settings` with business-wide access (held by Owner and Admin by default).
 */
export const cashierSessionRoutes = new Hono<Env>();

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const guard = [
  authenticate,
  resolveTenantContext,
  requireBusinessWideAccess,
  requirePermission('business:manage_settings'),
] as const;

cashierSessionRoutes.get('/', ...guard, async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const rows = await createRepositories(db).refreshTokens.listLiveCashierSessionsForBusiness(
      c.get('businessId'),
      Date.now(),
    );
    return ok(
      c,
      rows
        .filter((r) => r.sessionId !== null)
        .map((r) => ({
          sessionId: r.sessionId,
          user: { id: r.userId, name: r.userName, email: r.userEmail },
          branch: r.branchId ? { id: r.branchId, name: r.branchName } : null,
          deviceLabel: r.deviceLabel,
          lastActiveAt: r.lastActiveAt,
          expiresAt: r.expiresAt,
        })),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

// Mounted before '/:sessionId' so 'revoke-all' is never read as a session id.
cashierSessionRoutes.post('/revoke-all', ...guard, async (c) => {
  const businessId = c.get('businessId');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const revoked = await createRepositories(db).refreshTokens.revokeAllCashierSessionsForBusiness(businessId);
    c.set('auditMetadata', {
      action: 'cashier_session.revoked_all',
      entityType: 'business',
      entityId: businessId,
      details: { revoked },
    });
    return ok(c, { revoked });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

cashierSessionRoutes.delete('/:sessionId', ...guard, async (c) => {
  const sessionId = c.req.param('sessionId');
  // Same response for malformed, unknown, other-business and non-cashier ids: nothing to distinguish or probe.
  if (!SESSION_ID.test(sessionId)) throw new AppError('Cashier session not found.', 404, 'NOT_FOUND');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const revoked = await createRepositories(db).refreshTokens.revokeCashierSession(c.get('businessId'), sessionId);
    if (!revoked) throw new AppError('Cashier session not found.', 404, 'NOT_FOUND');
    c.set('auditMetadata', {
      action: 'cashier_session.revoked',
      entityType: 'session',
      entityId: sessionId,
      details: { sessionUserId: revoked.userId, branchId: revoked.branchId },
    });
    return ok(c, { revoked: true });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
