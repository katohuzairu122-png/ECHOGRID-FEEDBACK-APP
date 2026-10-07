import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { ok } from '../lib/response';

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

consentRoutes.get('/', async (c) =>
  withDb(c, async (db) => {
    const rows = await createRepositories(db).consentGrants.listForCustomer(c.get('customerId'));
    return ok(c, rows);
  }),
);

consentRoutes.post('/:id/revoke', async (c) =>
  withDb(c, async (db) => {
    await createRepositories(db).consentGrants.revoke(c.req.param('id'), c.get('customerId'));
    return ok(c, { revoked: true });
  }),
);
