import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { parseListPagination } from '../lib/list-pagination';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const consentRoutes = new Hono<Env>();
consentRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

consentRoutes.get('/', async (c) => {
  const { limit = 100, offset = 0 } = parseListPagination(new URL(c.req.url).searchParams, 100);
  return withDb(c, async (db) => {
    const rows = await createRepositories(db).consentGrants.listForCustomer(c.get('customerId'), { limit, offset });
    return ok(c, rows);
  });
});

consentRoutes.post('/:id/revoke', async (c) =>
  withDb(c, async (db) => {
    const revoked = await createRepositories(db).consentGrants.revoke(c.req.param('id'), c.get('customerId'));
    // DEV-70: a nonexistent, cross-customer, expired or already revoked
    // grant must not be represented as a successful state transition.
    if (!revoked) {
      throw new AppError('Active consent grant not found.', 404, 'CONSENT_GRANT_NOT_ACTIVE');
    }
    return ok(c, { revoked: true });
  }),
);
