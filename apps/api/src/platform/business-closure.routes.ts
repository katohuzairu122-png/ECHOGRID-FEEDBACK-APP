import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import { BusinessClosureService } from '../business-closure/business-closure.service';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables };

/**
 * BIZ-CLOSE-01: platform-admin VISIBILITY of business closure requests. Read-only by construction: there is no processing, approval or
 * rejection route, because closure processing is blocked until settlement, forfeiture, refund and retention policy are approved.
 */
export const platformBusinessClosureRoutes = new Hono<Env>();
platformBusinessClosureRoutes.use('*', authenticate, requirePlatformRole(['admin']));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withService<T>(c: { env: Bindings; executionCtx: { waitUntil(p: Promise<unknown>): void } }, fn: (s: BusinessClosureService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(new BusinessClosureService(db));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

platformBusinessClosureRoutes.get('/', async (c) => {
  const limit = Number(new URL(c.req.url).searchParams.get('limit')) || 50;
  c.header('Cache-Control', 'no-store');
  return ok(c, await withService(c, (s) => s.listPending(limit)));
});

platformBusinessClosureRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new AppError('Closure request not found.', 404, 'NOT_FOUND');
  const detail = await withService(c, (s) => s.detail(id));
  if (!detail) throw new AppError('Closure request not found.', 404, 'NOT_FOUND');
  c.header('Cache-Control', 'no-store');
  return ok(c, detail);
});
