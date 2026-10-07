import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { rateLimit } from '../middleware/rate-limit';
import { ok } from '../lib/response';

export const businessCategoryRoutes = new Hono<{ Bindings: Bindings }>();

businessCategoryRoutes.get('/', rateLimit('PUBLIC_RATE_LIMITER'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const categories = await createRepositories(db).businessCategories.listActive();
    return ok(
      c,
      categories.map((category) => ({
        key: category.key,
        name: category.name,
        groupKey: category.groupKey,
        description: category.description,
      })),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
