import { Hono, type Context } from 'hono';
import {
  orphanSettlementCompletionAuthorizationSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import {
  customerAuthenticate,
  type CustomerAuthVariables,
} from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { CustomerSettlementCompletionService } from './customer-settlement-completion.service';
import { OrphanSettlementTerminationService } from './orphan-settlement-termination.service';

type Env = {
  Bindings: Bindings;
  Variables: CustomerAuthVariables;
};

export const orphanSettlementCustomerRoutes = new Hono<Env>();

orphanSettlementCustomerRoutes.use(
  '*',
  customerAuthenticate,
  rateLimit('PUBLIC_RATE_LIMITER'),
);

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

orphanSettlementCustomerRoutes.get('/:settlementId', async (c) =>
  withDb(c, async (db) => {
    const result = await new CustomerSettlementCompletionService(db).getReview(
      c.get('customerId'),
      c.req.param('settlementId'),
    );

    return ok(c, {
      settlement: {
        id: result.settlement.id,
        claimId: result.settlement.claimId,
        receivingBusinessId: result.settlement.receivingBusinessId,
        receivingBranchId: result.settlement.receivingBranchId,
        status: result.settlement.status,
        fulfillmentPolicyVersion:
          result.settlement.fulfillmentPolicyVersion,
        fulfillmentSnapshot: result.settlement.fulfillmentSnapshot,
        fulfillmentReference: result.settlement.fulfillmentReference,
        expiresAt: result.settlement.expiresAt.toISOString(),
        completionAuthorizationId:
          result.settlement.completionAuthorizationId,
        completionAuthorizedAt:
          result.settlement.completionAuthorizedAt?.toISOString() ?? null,
      },
      claim: {
        id: result.claim.id,
        status: result.claim.status,
        sourceRewardType: result.claim.sourceRewardType,
      },
    });
  }),
);

orphanSettlementCustomerRoutes.post(
  '/:settlementId/authorize-completion',
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      orphanSettlementCompletionAuthorizationSchema,
    );

    return withDb(c, async (db) => {
      const result =
        await new CustomerSettlementCompletionService(
          db,
        ).authorizeCompletion(
          c.get('customerId'),
          c.req.param('settlementId'),
          body,
        );

      return ok(
        c,
        {
          settlement: {
            id: result.settlement.id,
            claimId: result.settlement.claimId,
            receivingBusinessId:
              result.settlement.receivingBusinessId,
            receivingBranchId:
              result.settlement.receivingBranchId,
            status: result.settlement.status,
            fulfillmentPolicyVersion:
              result.settlement.fulfillmentPolicyVersion,
            fulfillmentSnapshot:
              result.settlement.fulfillmentSnapshot,
            fulfillmentReference:
              result.settlement.fulfillmentReference,
            expiresAt: result.settlement.expiresAt.toISOString(),
            completionAuthorizationId:
              result.settlement.completionAuthorizationId,
            completionAuthorizedAt:
              result.settlement.completionAuthorizedAt?.toISOString() ??
              null,
          },
          authorization: {
            id: result.authorization.id,
            actionType: result.authorization.actionType,
            status: result.authorization.status,
            receivingBusinessId: result.authorization.businessId,
            resourceType: result.authorization.resourceType,
            resourceId: result.authorization.resourceId,
            scope: result.authorization.scope,
            correlationId: result.authorization.correlationId,
            expiresAt: result.authorization.expiresAt.toISOString(),
          },
          changed: result.changed,
        },
        result.changed ? 201 : 200,
      );
    });
  },
);


orphanSettlementCustomerRoutes.post(
  '/:settlementId/cancel',
  async (c) =>
    withDb(c, async (db) => {
      const result =
        await new OrphanSettlementTerminationService(db).cancelForCustomer(
          c.get('customerId'),
          c.req.param('settlementId'),
        );

      return ok(c, {
        settlement: {
          id: result.settlement.id,
          claimId: result.settlement.claimId,
          receivingBusinessId: result.settlement.receivingBusinessId,
          receivingBranchId: result.settlement.receivingBranchId,
          status: result.settlement.status,
        },
        claim: {
          id: result.claim.id,
          status: result.claim.status,
        },
        claimReleased: result.claimReleased,
        changed: result.changed,
      });
    }),
);
