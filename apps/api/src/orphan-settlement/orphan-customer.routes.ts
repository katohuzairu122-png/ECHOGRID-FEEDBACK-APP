import { Hono, type Context } from 'hono';
import { orphanSettlementAccessAuthorizationSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import type { OrphanRewardClaim } from '../repositories';
import { CustomerOrphanAccessService } from './customer-orphan-access.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const orphanCustomerRoutes = new Hono<Env>();
orphanCustomerRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

function parsePagination(c: Context<Env>) {
  const limit = c.req.query('limit') === undefined ? 100 : Number(c.req.query('limit'));
  const offset = c.req.query('offset') === undefined ? 0 : Number(c.req.query('offset'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    throw new AppError('Invalid pagination.', 400, 'PAGINATION_INVALID');
  }
  return { limit, offset };
}

function serializeClaim(row: OrphanRewardClaim) {
  return {
    id: row.id,
    originBusinessId: row.originBusinessId,
    originMembershipId: row.originMembershipId,
    originLoyaltyAccountId: row.originLoyaltyAccountId,
    originLoyaltyTransactionId: row.originLoyaltyTransactionId,
    originRewardId: row.originRewardId,
    orphanReason: row.orphanReason,
    status: row.status,
    sourceRewardType: row.sourceRewardType,
    sourceRewardSnapshot: row.sourceRewardSnapshot,
    createdAt: row.createdAt.toISOString(),
    qualifiedAt: row.qualifiedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    reversedAt: row.reversedAt?.toISOString() ?? null,
  };
}

orphanCustomerRoutes.get('/', async (c) => {
  const pagination = parsePagination(c);
  return withDb(c, async (db) => {
    const rows = await new CustomerOrphanAccessService(db).listClaims(c.get('customerId'), pagination);
    return ok(c, {
      claims: rows.map(serializeClaim),
      pagination: { ...pagination, returned: rows.length },
    });
  });
});

orphanCustomerRoutes.get('/:claimId', async (c) =>
  withDb(c, async (db) => {
    const claim = await new CustomerOrphanAccessService(db).getClaim(
      c.get('customerId'),
      c.req.param('claimId'),
    );
    return ok(c, { claim: serializeClaim(claim) });
  }),
);

orphanCustomerRoutes.post('/:claimId/authorize-access', async (c) => {
  const body = await parseJsonBody(c.req.raw, orphanSettlementAccessAuthorizationSchema);
  return withDb(c, async (db) => {
    const result = await new CustomerOrphanAccessService(db).authorizeAccess(
      c.get('customerId'),
      c.req.param('claimId'),
      body,
    );
    return ok(c, {
      claim: serializeClaim(result.claim),
      consentGrantId: result.consent.id,
      authorization: {
        id: result.authorization.id,
        receivingBusinessId: result.authorization.businessId,
        actionType: result.authorization.actionType,
        status: result.authorization.status,
        correlationId: result.authorization.correlationId,
        expiresAt: result.authorization.expiresAt.toISOString(),
      },
      settlement: {
        id: result.settlement.id,
        receivingBusinessId: result.settlement.receivingBusinessId,
        status: result.settlement.status,
        expiresAt: result.settlement.expiresAt.toISOString(),
      },
      changed: result.changed,
    }, result.changed ? 201 : 200);
  });
});
