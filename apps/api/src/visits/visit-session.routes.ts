import { Hono } from 'hono';
import { issueVisitSessionSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { BranchService } from '../branches/branch.service';
import { VisitSessionService } from './visit-session.service';
import type { VisitSession } from '../repositories/visit-session.repository';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

/**
 * Staff-facing visit-session issue/revoke (Continuing Development Block
 * 4.3.1, S5.3). Mounted at the SAME /branches prefix as branch.routes.ts, a
 * second file rather than added to that one -- the same "two files, one
 * prefix, split by concern" precedent index.ts documents for the
 * platform/billing route pairs. Split here specifically because this is a
 * `visits` feature concern nested under a branch URL, not branch-entity
 * CRUD itself -- matching how loyalty's tiers/rewards live in
 * loyalty.routes.ts rather than branch.routes.ts despite also being
 * business-scoped resources.
 *
 * Gated by branches:manage -- the same permission key QR-code management
 * already reuses for an identical shape of problem (a branch-scoped,
 * staff-issued code). A dedicated visits:* permission is a clean future
 * refinement if finer-grained control is ever needed; adding one now would
 * mean a permissions-table seed change for zero present benefit, since
 * nothing today would use a narrower grant differently.
 *
 * No verification route here -- these two endpoints only ISSUE and REVOKE a
 * code. Customer-facing verification (VisitSessionService.verify(), wired
 * into feedback submit and loyalty check-in) is Block 4.3.2's concern, a
 * deliberately separate block per the approved roadmap: this block changes
 * nothing about any existing, live route. No list/GET endpoint either --
 * issuing a session already returns it in full, and nothing yet needs to
 * re-list them; an easy addition later if a staff UI needs it.
 */
export const visitSessionRoutes = new Hono<Env>();

visitSessionRoutes.use('*', authenticate, resolveTenantContext);

/** Hand-picks public-safe fields into shared-types' VisitSessionDto shape --
 * never returns the raw repository row. Same reasoning branches.ts's own
 * branchSchema doc comment gives: audit/soft-delete columns (createdBy,
 * isDeleted, deletedAt, deletedBy, updatedBy) are internal and never
 * exposed, matching every other DTO in this codebase. */
function serializeVisitSession(session: VisitSession) {
  return {
    id: session.id,
    businessId: session.businessId,
    branchId: session.branchId,
    code: session.code,
    status: session.status,
    expiresAt: session.expiresAt.toISOString(),
    maxUses: session.maxUses,
    useCount: session.useCount,
    createdAt: session.createdAt.toISOString(),
  };
}

visitSessionRoutes.post('/:branchId/visit-sessions', requirePermission('branches:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, issueVisitSessionSchema);
  const branchId = c.req.param('branchId');
  const businessId = c.get('businessId');

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    // Same pre-check QR regenerate uses (branch.routes.ts) -- confirms the
    // branch actually belongs to the caller's tenant (404s otherwise)
    // before creating anything scoped to it.
    await new BranchService(repos).getBranch(branchId, businessId);

    const session = await new VisitSessionService(repos).issue(businessId, branchId, c.get('userId'), {
      ttlSeconds: body.ttlSeconds,
      maxUses: body.maxUses ?? null,
    });

    c.set('auditMetadata', {
      action: 'visit_session.issued',
      entityType: 'visit_session',
      entityId: session.id,
      details: { branchId, ttlSeconds: body.ttlSeconds, maxUses: body.maxUses ?? null },
    });

    return ok(c, serializeVisitSession(session), 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Action-verb path, not HTTP DELETE -- same convention QR's own
 * /regenerate uses: this flips status to 'revoked', it does not remove the
 * row (audit/history value, same reasoning qr_codes' and visit_sessions'
 * own revoke() give).
 *
 * Always 204, whether or not `id` actually matched an active session under
 * this business -- no separate existence check before revoking. This
 * mirrors VisitSessionService/the repository's own enumeration-resistance
 * theme (verify() never reveals whether a code "exists" either) rather than
 * introducing a new 404-vs-204 signal that would leak cross-tenant
 * existence information for no operational benefit.
 */
visitSessionRoutes.post(
  '/:branchId/visit-sessions/:id/revoke',
  requirePermission('branches:manage'),
  async (c) => {
    const branchId = c.req.param('branchId');
    const id = c.req.param('id');
    const businessId = c.get('businessId');

    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      await new BranchService(repos).getBranch(branchId, businessId);
      await new VisitSessionService(repos).revoke(id, businessId, c.get('userId'));

      c.set('auditMetadata', {
        action: 'visit_session.revoked',
        entityType: 'visit_session',
        entityId: id,
        details: { branchId },
      });

      return c.body(null, 204);
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
