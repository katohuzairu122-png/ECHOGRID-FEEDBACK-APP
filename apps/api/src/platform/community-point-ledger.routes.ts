import { Hono } from 'hono';
import {
  communityPointLedgerQuerySchema,
  type CommunityPointTransactionDto,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories, type CommunityPointTransaction } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import {
  requirePlatformRole,
  type PlatformVariables,
} from '../middleware/require-platform-role';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { requireCommunityPlatformPermission } from './community-permissions';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables;
};

export const platformCommunityPointLedgerRoutes = new Hono<Env>();

platformCommunityPointLedgerRoutes.use(
  '*',
  authenticate,
  requirePlatformRole(['support', 'billing', 'admin']),
  requireCommunityPlatformPermission('community:ledger:view'),
);

function serializeTransaction(
  row: CommunityPointTransaction,
): CommunityPointTransactionDto {
  return {
    id: row.id,
    accountId: row.accountId,
    customerId: row.customerId,
    type: row.type,
    points: row.points,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    ruleId: row.ruleId,
    awardDecisionId: row.awardDecisionId,
    businessId: row.businessId,
    branchId: row.branchId,
    reversalOf: row.reversalOf,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

platformCommunityPointLedgerRoutes.get('/', async (c) => {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = communityPointLedgerQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'Invalid Community Point ledger query.',
      400,
      'COMMUNITY_LEDGER_QUERY_INVALID',
      parsed.error.flatten(),
    );
  }

  const { limit, offset, ...filters } = parsed.data;
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const transactions = await createRepositories(db).communityPointTransactions.listPlatform(
      filters,
      { limit, offset },
    );

    return ok(c, {
      transactions: transactions.map(serializeTransaction),
      pagination: {
        limit,
        offset,
        returned: transactions.length,
      },
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
