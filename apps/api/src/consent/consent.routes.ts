import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { isUuid } from '../lib/uuid';
import { parseListPagination } from '../lib/list-pagination';
import { ConsentWithdrawalService } from './consent-withdrawal.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const consentRoutes = new Hono<Env>();
consentRoutes.use('*', customerAuthenticate, rateLimitByCustomer());

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

const grantNotActive = () => new AppError('Active consent grant not found.', 404, 'CONSENT_GRANT_NOT_ACTIVE');

consentRoutes.post('/:id/revoke', async (c) => {
  const grantId: string | undefined = c.req.param('id');
  // A malformed id cannot name a grant: answer as for any grant that is not
  // active, instead of letting the database reject it (a 500).
  if (grantId === undefined || !isUuid(grantId)) throw grantNotActive();
  return withDb(c, async (db) => {
    // Withdrawing the join_loyalty consent also ends that loyalty membership
    // (Split 01); every other purpose is a plain revoke.
    const revoked = await new ConsentWithdrawalService(db).revoke(grantId, c.get('customerId'));
    // DEV-70: a nonexistent, cross-customer, expired or already revoked
    // grant must not be represented as a successful state transition.
    if (!revoked) throw grantNotActive();
    return ok(c, { revoked: true });
  });
});
