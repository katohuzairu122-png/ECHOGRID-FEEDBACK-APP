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
import { NetworkFollowService } from './network-follow.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };
const HANDLE = /^[A-Za-z0-9_-]{22}$/;

/**
 * BCOMM-04 follows (`/network/follows`), signed-in customers only, customer id from the session. Following needs the Feed AND business
 * distribution to be open; viewing and removing the customer's OWN follows needs only the Feed, so a customer can always undo a follow while
 * distribution is closed. A follow never enrolls anyone, grants consent or sends anything.
 */
export const networkFollowRoutes = new Hono<Env>();
networkFollowRoutes.use('*', customerAuthenticate, rateLimitByCustomer());

async function withService<T>(c: Context<Env>, work: (service: NetworkFollowService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    await assertVerifiedPhone(createRepositories(db), c.get('customerId'), 'network');
    return await work(new NetworkFollowService(db));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}
const requireFeed = (c: Context<Env>) => {
  if (!isNetworkFeedEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
};
const handleParam = (c: Context<Env>) => {
  const handle = c.req.param('profileHandle') ?? '';
  if (!HANDLE.test(handle)) throw new AppError('Not found.', 404, 'NETWORK_NOT_FOUND');
  return handle;
};

networkFollowRoutes.get('/', (c) => {
  requireFeed(c);
  return withService(c, async (service) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await service.list(c.get('customerId')));
  });
});

networkFollowRoutes.put('/:profileHandle', (c) => {
  requireFeed(c);
  if (!isBusinessDistributionEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  return withService(c, async (service) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await service.follow(c.get('customerId'), handleParam(c)));
  });
});

networkFollowRoutes.delete('/:profileHandle', (c) => {
  requireFeed(c);
  return withService(c, async (service) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await service.unfollow(c.get('customerId'), handleParam(c)));
  });
});
