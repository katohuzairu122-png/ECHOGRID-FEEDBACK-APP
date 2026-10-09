import { Hono, type Context } from 'hono';
import {
  orphanSettlementAcceptSchema,
  orphanSettlementBusinessAccessSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import {
  authenticate,
  type AuthVariables,
} from '../middleware/authenticate';
import {
  resolveTenantContext,
  type TenantVariables,
} from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { ReceivingBusinessSettlementService } from './receiving-business-settlement.service';
import { OrphanSettlementFulfillmentService } from './orphan-settlement-fulfillment.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables;
};

export const settlementBusinessRoutes = new Hono<Env>();

settlementBusinessRoutes.use('*', authenticate, resolveTenantContext);

async function withDb<T>(
  c: Context<Env>,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

settlementBusinessRoutes.post(
  '/access',
  requirePermission('settlement:view'),
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      orphanSettlementBusinessAccessSchema,
    );

    return withDb(c, async (db) => {
      const result =
        await new ReceivingBusinessSettlementService(
          db,
        ).inspectAuthorizedClaim({
          businessId: c.get('businessId'),
          ...(c.get('branchId') !== undefined
            ? { branchId: c.get('branchId') }
            : {}),
          access: body,
        });

      return ok(c, {
        settlementId: result.settlementId,
        claimId: result.claimId,
        receivingBusinessId: result.receivingBusinessId,
        receivingBranchId: result.receivingBranchId,
        settlementStatus: result.settlementStatus,
        authorizationExpiresAt:
          result.authorizationExpiresAt.toISOString(),
        claim: result.claim,
      });
    });
  },
);

settlementBusinessRoutes.post(
  '/:settlementId/accept',
  requirePermission('settlement:accept'),
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      orphanSettlementAcceptSchema,
    );

    return withDb(c, async (db) => {
      const result =
        await new ReceivingBusinessSettlementService(db).acceptAndReserve({
          businessId: c.get('businessId'),
          ...(c.get('branchId') !== undefined
            ? { branchId: c.get('branchId') }
            : {}),
          actorUserId: c.get('userId'),
          settlementId: c.req.param('settlementId'),
          acceptance: body,
        });

      return ok(c, {
        settlement: {
          id: result.settlement.id,
          claimId: result.settlement.claimId,
          receivingBusinessId: result.settlement.receivingBusinessId,
          receivingBranchId: result.settlement.receivingBranchId,
          status: result.settlement.status,
          acceptedByUserId: result.settlement.acceptedByUserId,
          acceptedAt: result.settlement.acceptedAt?.toISOString() ?? null,
          fulfillmentPolicyVersion:
            result.settlement.fulfillmentPolicyVersion,
          fulfillmentSnapshot: result.settlement.fulfillmentSnapshot,
          fulfillmentReference: result.settlement.fulfillmentReference,
          expiresAt: result.settlement.expiresAt.toISOString(),
        },
        claim: {
          id: result.claim.id,
          status: result.claim.status,
        },
        changed: result.changed,
      });
    });
  },
);


settlementBusinessRoutes.post(
  '/:settlementId/fulfill',
  requirePermission('settlement:fulfill'),
  async (c) =>
    withDb(c, async (db) => {
      const result = await new OrphanSettlementFulfillmentService(db).fulfill({
        businessId: c.get('businessId'),
        ...(c.get('branchId') !== undefined
          ? { branchId: c.get('branchId') }
          : {}),
        actorUserId: c.get('userId'),
        settlementId: c.req.param('settlementId'),
      });

      return ok(c, {
        settlement: {
          id: result.settlement.id,
          claimId: result.settlement.claimId,
          receivingBusinessId: result.settlement.receivingBusinessId,
          receivingBranchId: result.settlement.receivingBranchId,
          status: result.settlement.status,
          fulfilledByUserId: result.settlement.fulfilledByUserId,
          fulfilledAt: result.settlement.fulfilledAt?.toISOString() ?? null,
          fulfillmentPolicyVersion:
            result.settlement.fulfillmentPolicyVersion,
          fulfillmentReference: result.settlement.fulfillmentReference,
        },
        claim: {
          id: result.claim.id,
          status: result.claim.status,
          settledAt: result.claim.settledAt?.toISOString() ?? null,
        },
        completionEvidence: {
          evidenceVersion: result.evidence.evidenceVersion,
          settlementRef: result.evidence.settlementRef,
        },
        changed: result.changed,
      });
    }),
);
