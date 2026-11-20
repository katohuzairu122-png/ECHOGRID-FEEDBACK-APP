import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { ok } from '../lib/response';
import { rateLimit } from '../middleware/rate-limit';

/**
 * LANDING-ROLE-01: the anonymous "find the business you want to join" list for the customer sign-up page. Read-only and NAME ONLY:
 * no id, slug, address, owner or contact is returned, and only active businesses that already have an active loyalty QR code appear.
 * Joining still happens only by scanning that business's QR code (the existing /loyalty/:token flow); this route creates nothing.
 * Reached through the web app's server component (BFF), stacked on the global limiter with the stricter public limiter.
 */
export const publicBusinessDirectoryRoutes = new Hono<{ Bindings: Bindings }>();

publicBusinessDirectoryRoutes.use('*', rateLimit('PUBLIC_RATE_LIMITER'));

const MAX_SEARCH_LENGTH = 80;

publicBusinessDirectoryRoutes.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, MAX_SEARCH_LENGTH);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const names = await createRepositories(db).businesses.listNamesForCustomerDirectory({ search: q });
    c.header('Cache-Control', 'public, max-age=60');
    return ok(c, { businesses: names.map((name) => ({ name })) });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
