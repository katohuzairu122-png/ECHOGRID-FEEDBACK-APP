import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { createDb } from '../db/client';
import { assertVerifiedPhone } from '../lib/customer-verification';
import { createRepositories } from '../repositories';
import { isBusinessDistributionEnabled, isNetworkFeedEnabled } from './network-flag';
import { NetworkEngagementService } from './network-engagement.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

/**
 * BCOMM-05: `POST /network/engagement/:handle` records that the signed-in customer OPENED a visible business post's link. Same gates as the
 * Feed (Feed flag, business distribution control, verified phone), customer id from the session, a generic not-found for anything the customer
 * could not see, and one count per customer, post and UTC day. No business role can reach this route, so a business cannot add to its own totals.
 */
export const networkEngagementRoutes = new Hono<Env>();
networkEngagementRoutes.use('*', customerAuthenticate, rateLimitByCustomer());

networkEngagementRoutes.post('/:handle', async (c: Context<Env>) => {
  if (!isNetworkFeedEnabled(c.env) || !isBusinessDistributionEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    await assertVerifiedPhone(createRepositories(db), c.get('customerId'), 'network');
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await new NetworkEngagementService(db).recordEngagement(c.get('customerId'), c.req.param('handle') ?? ''));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
