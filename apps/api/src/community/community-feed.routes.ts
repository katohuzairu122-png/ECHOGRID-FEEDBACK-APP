import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import {
  customerAuthenticate,
  type CustomerAuthVariables,
} from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { emptyFeedSource, toFeedItemDto, type FeedSource } from './community-feed';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 50;

/** Strict: any unknown key (for example a client-supplied customerId or businessId) is rejected. */
const feedQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(FEED_MAX_LIMIT).optional(),
    cursor: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

/**
 * Customer Community feed (read-only). Authenticated customers only; the customer identity comes from the
 * session, never from the request. No write, publish, report or follow endpoint exists. Fails closed: a
 * failing or contract-violating source yields a generic 503 with no detail.
 */
export function createCommunityFeedRoutes(options: { source: FeedSource }) {
  const routes = new Hono<Env>();
  routes.use('*', customerAuthenticate, rateLimitByCustomer());

  routes.get('/', async (c) => {
    const parsed = feedQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new AppError('Invalid feed query.', 400, 'VALIDATION_ERROR');
    }
    const limit = parsed.data.limit ?? FEED_DEFAULT_LIMIT;

    let page;
    try {
      const raw = await options.source.listVisible({
        customerId: c.get('customerId'),
        cursor: parsed.data.cursor ?? null,
        limit,
      });
      if (!Array.isArray(raw.items) || raw.items.length > limit) {
        throw new Error('feed source returned an invalid page');
      }
      page = { items: raw.items.map(toFeedItemDto), nextCursor: raw.nextCursor ?? null };
    } catch {
      throw new AppError('The feed is unavailable.', 503, 'FEED_UNAVAILABLE');
    }

    c.header('Cache-Control', 'private, no-store');
    return ok(c, page);
  });

  return routes;
}

/** The mounted instance uses the empty source until a feed publication policy is approved and implemented. */
export const communityFeedRoutes = createCommunityFeedRoutes({ source: emptyFeedSource });
