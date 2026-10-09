import { Hono, type Context } from 'hono';
import {
  orphanSettlementAcceptSchema,
  orphanSettlementBusinessAccessSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
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
import { AppError } from '../lib/errors';
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

function parsePagination(c: Context<Env>) {
  const limit =
    c.req.query('limit') === undefined ? 100 : Number(c.req.query('limit'));
  const offset =
    c.req.query('offset') === undefined ? 0 : Number(c.req.query('offset'));

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new AppError('Invalid pagination.', 400, 'PAGINATION_INVALID');
  }

  return { limit, offset };
}

settlementBusinessRoutes.get(
  '/',
  requirePermission('settlement:view'),
  async (c) => {
    const pagination = parsePagination(c);

    return withDb(c, async (db) => {
      const rows = await createRepositories(db).orphanSettlements.listForReceivingBusiness(
        c.get('businessId'),
        {
          ...(c.get('branchId') !== undefined
            ? { branchId: c.get('branchId') }
            : {}),
          ...pagination,
        },
      );

      return ok(c, {
        settlements: rows.map((row) => ({
          id: row.id,
          claimId: row.claimId,
          receivingBusinessId: row.receivingBusinessId,
          receivingBranchId: row.receivingBranchId,
          status: row.status,
          acceptedAt: row.acceptedAt?.toISOString() ?? null,
          completionAuthorizedAt:
            row.completionAuthorizedAt?.toISOString() ?? null,
          fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
          fulfillmentPolicyVersion: row.fulfillmentPolicyVersion,
          fulfillmentSnapshot: row.fulfillmentSnapshot,
          fulfillmentReference: row.fulfillmentReference,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        pagination: {
          ...pagination,
          returned: rows.length,
        },
      });
    });
  },
);

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
