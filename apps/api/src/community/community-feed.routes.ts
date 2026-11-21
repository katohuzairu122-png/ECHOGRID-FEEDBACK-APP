import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { NETWORK_FEED_MAX_LIMIT, networkFeedPageSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import {
  customerAuthenticate,
  type CustomerAuthVariables,
} from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { createDb } from '../db/client';
import type { FeedSource } from './community-feed';
import { createNetworkFeedSource } from '../network/network-feed-source';
import { isNetworkFeedEnabled } from '../network/network-flag';
import { assertVerifiedPhone } from '../lib/customer-verification';
import { createRepositories } from '../repositories';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = NETWORK_FEED_MAX_LIMIT;

/** Strict: any unknown key (for example a client-supplied customerId or businessId) is rejected. */
const feedQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(FEED_MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();

export type FeedSourceHandle = { source: FeedSource; release?: () => void };

/**
 * Customer Network surface (read-only), mounted at /network. Authenticated customers only; the customer identity
 * comes from the session, never from the request. No write, publish, report or follow endpoint exists.
 *
 * Feature flag (NT-17): with the flag off, GET /network/feed answers the same generic 404 as an unmounted path and
 * GET /network/status reports `enabled: false` so the web layer can hide the Feed section. Fails closed: a failing
 * or contract-violating source yields a generic 503 with no detail.
 */
export function createCommunityFeedRoutes(options: {
  isEnabled: (env: Bindings) => boolean;
  openSource: (c: Context<Env>) => Promise<FeedSourceHandle>;
  /** Required: Network is a restricted feature. Throws PHONE_VERIFICATION_REQUIRED unless the session customer's phone is verified. */
  assertVerifiedPhone: (c: Context<Env>, customerId: string) => Promise<void>;
}) {
  const routes = new Hono<Env>();
  routes.use('*', customerAuthenticate, rateLimitByCustomer());

  routes.get('/status', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, { enabled: options.isEnabled(c.env) });
  });

  routes.get('/feed', async (c) => {
    if (!options.isEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
    const parsed = feedQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new AppError('Invalid feed query.', 400, 'VALIDATION_ERROR');
    await options.assertVerifiedPhone(c, c.get('customerId'));
    const limit = parsed.data.limit ?? FEED_DEFAULT_LIMIT;

    let page;
    let handle: FeedSourceHandle | undefined;
    try {
      handle = await options.openSource(c);
      const raw = await handle.source.listVisible({
        customerId: c.get('customerId'),
        cursor: parsed.data.cursor ?? null,
        limit,
      });
      page = networkFeedPageSchema.parse(raw);
      if (page.items.length > limit) throw new Error('feed source returned an invalid page');
    } catch {
      throw new AppError('The feed is unavailable.', 503, 'FEED_UNAVAILABLE');
    } finally {
      handle?.release?.();
    }

    c.header('Cache-Control', 'private, no-store');
    return ok(c, page);
  });

  return routes;
}

/** Mounted instance: flag off by default; a DB-backed source over network_* only, on the existing runtime connection. */
export const communityFeedRoutes = createCommunityFeedRoutes({
  isEnabled: isNetworkFeedEnabled,
  assertVerifiedPhone: async (c, customerId) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      await assertVerifiedPhone(createRepositories(db), customerId, 'network');
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
  openSource: async (c) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    return { source: createNetworkFeedSource(db), release: () => c.executionCtx.waitUntil(close()) };
  },
});
