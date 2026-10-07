import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import {
  customerAuthenticate,
  type CustomerAuthVariables,
} from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { CommunityPointCustomerService } from './community-point-customer.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const communityPointCustomerRoutes = new Hono<Env>();

communityPointCustomerRoutes.use(
  '*',
  customerAuthenticate,
  rateLimit('PUBLIC_RATE_LIMITER'),
);

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

function serializeAccount(row: {
  id: string;
  customerId: string;
  status: 'active' | 'suspended' | 'closed';
  pointsBalance: number;
  createdAt: Date;
  updatedAt: Date;
} | null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    pointsBalance: row.pointsBalance,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTransaction(row: {
  id: string;
  type: 'earn' | 'redeem' | 'reverse' | 'expire' | 'admin_adjustment';
  points: number;
  sourceType:
    | 'survey_completion'
    | 'redemption'
    | 'reversal'
    | 'expiration'
    | 'admin_adjustment';
  businessId: string | null;
  branchId: string | null;
  reversalOf: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    points: row.points,
    sourceType: row.sourceType,
    businessId: row.businessId,
    branchId: row.branchId,
    reversalOf: row.reversalOf,
    createdAt: row.createdAt.toISOString(),
  };
}

function parsePagination(c: Context<Env>): { limit: number; offset: number } {
  const rawLimit = c.req.query('limit');
  const rawOffset = c.req.query('offset');
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new AppError(
      'limit must be an integer between 1 and 200.',
      400,
      'PAGINATION_INVALID',
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError(
      'offset must be a non-negative integer.',
      400,
      'PAGINATION_INVALID',
    );
  }
  return { limit, offset };
}

communityPointCustomerRoutes.get('/', async (c) =>
  withDb(c, async (db) => {
    const result = await new CommunityPointCustomerService(db).getSummary(
      c.get('customerId'),
    );
    return ok(c, { account: serializeAccount(result.account) });
  }),
);

communityPointCustomerRoutes.get('/transactions', async (c) => {
  const pagination = parsePagination(c);
  return withDb(c, async (db) => {
    const rows = await new CommunityPointCustomerService(db).listTransactions(
      c.get('customerId'),
      pagination,
    );
    return ok(c, {
      transactions: rows.map(serializeTransaction),
      pagination: {
        limit: pagination.limit,
        offset: pagination.offset,
        returned: rows.length,
      },
    });
  });
});
