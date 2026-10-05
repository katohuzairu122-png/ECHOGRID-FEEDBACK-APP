import { Hono, type Context } from 'hono';
import {
  branchProgramSchema,
  branchJoinSchema,
  branchPurchaseSchema,
  branchRefundSchema,
  branchRedeemSchema,
  branchConfirmSchema,
  communityConsentSchema,
  branchFeedbackSchema,
} from '@echo-grid-feedback/shared-types';
import { enqueueClassification } from '../sentiment/sentiment-job';
import { runInBackground } from '../lib/background-db';
import { NotificationService } from '../notifications/notification.service';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import {
  customerAuthenticate,
  type CustomerAuthVariables,
} from '../middleware/customer-authenticate';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import type { AuditVariables } from '../middleware/audit';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { QrCodeService } from '../qr/qr-code.service';
import { BranchLoyaltyService } from './branch-loyalty.service';

type CustomerEnv = { Bindings: Bindings; Variables: CustomerAuthVariables };
type StaffEnv = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };
type PublicEnv = { Bindings: Bindings };
async function withDb<T, E extends { Bindings: Bindings }>(
  c: Context<E>,
  fn: (db: Database) => Promise<T>,
) {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}
async function qrContext(db: Database, env: Bindings, token: string) {
  return new QrCodeService(createRepositories(db), {
    QR_TOKEN_SECRET: env.QR_TOKEN_SECRET,
    QR_TOKEN_SECRET_PREVIOUS: env.QR_TOKEN_SECRET_PREVIOUS,
  }).resolveToken(token);
}
export const branchLoyaltyPublicRoutes = new Hono<PublicEnv>();
branchLoyaltyPublicRoutes.use('*', rateLimit('PUBLIC_RATE_LIMITER'));
branchLoyaltyPublicRoutes.get('/directory', (c) =>
  withDb(c, async (db) => ok(c, await new BranchLoyaltyService(db).directory())),
);
branchLoyaltyPublicRoutes.get('/qr/:token', (c) =>
  withDb(c, async (db) => {
    const qr = await qrContext(db, c.env, c.req.param('token'));
    const program = await new BranchLoyaltyService(db).program(qr.businessId, qr.branchId);
    return ok(c, program ?? null);
  }),
);

export const branchLoyaltyCustomerRoutes = new Hono<CustomerEnv>();
branchLoyaltyCustomerRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));
branchLoyaltyCustomerRoutes.get('/memberships', (c) =>
  withDb(c, async (db) => ok(c, await new BranchLoyaltyService(db).list(c.get('customerId')))),
);
branchLoyaltyCustomerRoutes.get('/community', (c) =>
  withDb(c, async (db) =>
    ok(c, await new BranchLoyaltyService(db).communityChoice(c.get('customerId'))),
  ),
);
branchLoyaltyCustomerRoutes.post('/community', async (c) => {
  const body = await parseJsonBody(c.req.raw, communityConsentSchema);
  return withDb(c, async (db) =>
    ok(c, await new BranchLoyaltyService(db).setCommunityChoice(c.get('customerId'), body.joined)),
  );
});
branchLoyaltyCustomerRoutes.post('/join', async (c) => {
  const body = await parseJsonBody(c.req.raw, branchJoinSchema);
  return withDb(c, async (db) => {
    const qr = await qrContext(db, c.env, body.qrToken);
    return ok(
      c,
      await new BranchLoyaltyService(db).join(
        c.get('customerId'),
        qr.businessId,
        qr.branchId,
        body.joinCommunity,
      ),
      201,
    );
  });
});
branchLoyaltyCustomerRoutes.post('/feedback', async (c) => {
  const body = await parseJsonBody(c.req.raw, branchFeedbackSchema);
  return withDb(c, async (db) => {
    const qr = await qrContext(db, c.env, body.qrToken);
    const created = await new BranchLoyaltyService(db).verifiedFeedback(
      c.get('customerId'),
      qr,
      body.purchaseId,
      body.feedback,
    );
    if (created.wasInserted) {
      c.executionCtx.waitUntil(enqueueClassification(c.env.JOBS, created.id, created.businessId));
      c.executionCtx.waitUntil(
        runInBackground(c.env.HYPERDRIVE, async (repos) => {
          const [business, branch] = await Promise.all([
            repos.businesses.findById(qr.businessId),
            repos.branches.findById(qr.branchId, qr.businessId),
          ]);
          if (!business || !branch) return;
          const notifications = new NotificationService(repos, c.env.JOBS);
          await notifications.notifyBusinessStaff(qr.businessId, {
            eventType: 'feedback_received',
            businessName: business.name,
            branchName: branch.name,
            rating: created.rating,
            comment: created.comment ?? undefined,
          });
          if (created.urgency === 'P0_CRITICAL') {
            const incident = await repos.criticalIncidents.findByFeedbackId(
              created.id,
              qr.businessId,
            );
            await notifications.notifyBusinessStaff(
              qr.businessId,
              {
                eventType: 'critical_feedback_alert',
                businessName: business.name,
                branchName: branch.name,
                matchedSignals: incident?.matchedSignals ?? 'unspecified',
              },
              'feedback:manage',
            );
          }
        }),
      );
    }
    return ok(c, { id: created.id, verifiedPurchase: true }, created.wasInserted ? 201 : 200);
  });
});
branchLoyaltyCustomerRoutes.get('/memberships/:id/history', (c) =>
  withDb(c, async (db) =>
    ok(c, await new BranchLoyaltyService(db).history(c.get('customerId'), c.req.param('id'))),
  ),
);
branchLoyaltyCustomerRoutes.post('/memberships/:id/redeem', async (c) => {
  const body = await parseJsonBody(c.req.raw, branchRedeemSchema);
  return withDb(c, async (db) =>
    ok(
      c,
      await new BranchLoyaltyService(db).redeem(
        c.get('customerId'),
        c.req.param('id'),
        body.requestId,
      ),
    ),
  );
});

export const branchLoyaltyStaffRoutes = new Hono<StaffEnv>();
branchLoyaltyStaffRoutes.use('*', authenticate, resolveTenantContext);
function assertBranch(c: Context<StaffEnv>): string {
  const branchId = c.req.param('branchId');
  if (!branchId || (!c.get('businessWideAccess') && c.get('branchId') !== branchId)) {
    throw new AppError('You do not have access to this branch.', 403, 'BRANCH_ACCESS_DENIED');
  }
  return branchId;
}
branchLoyaltyStaffRoutes.get(
  '/branches/:branchId/program',
  requirePermission('loyalty:view'),
  (c) =>
    withDb(c, async (db) =>
      ok(
        c,
        (await new BranchLoyaltyService(db).program(c.get('businessId'), assertBranch(c))) ?? null,
      ),
    ),
);
branchLoyaltyStaffRoutes.put(
  '/branches/:branchId/program',
  requirePermission('loyalty:manage'),
  requireBusinessWideAccess,
  async (c) => {
    const body = await parseJsonBody(c.req.raw, branchProgramSchema);
    return withDb(c, async (db) => {
      const branchId = assertBranch(c);
      const program = await new BranchLoyaltyService(db).configure(
        c.get('businessId'),
        branchId,
        body,
        c.get('userId'),
      );
      c.set('auditMetadata', {
        action: 'branch_loyalty.program_configured',
        entityType: 'branch',
        entityId: branchId,
      });
      return ok(c, program);
    });
  },
);
branchLoyaltyStaffRoutes.post(
  '/branches/:branchId/purchases',
  requirePermission('loyalty:manage'),
  async (c) => {
    const body = await parseJsonBody(c.req.raw, branchPurchaseSchema);
    return withDb(c, async (db) => {
      const entry = await new BranchLoyaltyService(db).purchase(
        c.get('businessId'),
        assertBranch(c),
        body,
        c.get('userId'),
      );
      c.set('auditMetadata', {
        action: 'branch_loyalty.purchase_confirmed',
        entityType: 'branch_loyalty_ledger',
        entityId: entry!.id,
      });
      return ok(c, entry, 201);
    });
  },
);
branchLoyaltyStaffRoutes.post(
  '/branches/:branchId/refunds',
  requirePermission('loyalty:manage'),
  async (c) => {
    const body = await parseJsonBody(c.req.raw, branchRefundSchema);
    return withDb(c, async (db) => {
      const entry = await new BranchLoyaltyService(db).refund(
        c.get('businessId'),
        assertBranch(c),
        body.purchaseId,
        body.reason,
        c.get('userId'),
      );
      c.set('auditMetadata', {
        action: 'branch_loyalty.purchase_refunded',
        entityType: 'branch_loyalty_ledger',
        entityId: entry!.id,
      });
      return ok(c, entry);
    });
  },
);
branchLoyaltyStaffRoutes.post(
  '/branches/:branchId/confirm',
  requirePermission('loyalty:manage'),
  async (c) => {
    const body = await parseJsonBody(c.req.raw, branchConfirmSchema);
    return withDb(c, async (db) => {
      const entry = await new BranchLoyaltyService(db).confirm(
        c.get('businessId'),
        assertBranch(c),
        body.code,
        c.get('userId'),
      );
      c.set('auditMetadata', {
        action: 'branch_loyalty.reward_fulfilled',
        entityType: 'branch_loyalty_ledger',
        entityId: entry!.id,
      });
      return ok(c, entry);
    });
  },
);
