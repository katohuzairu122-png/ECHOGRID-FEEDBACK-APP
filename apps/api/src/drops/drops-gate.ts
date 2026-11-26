import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { isTentashipDropsEnabled } from './drops-flag';

/** Mounted FIRST on every Drops route: generic 404 before authentication unless TENTASHIP_DROPS_ENABLED is exactly "true". */
export const tentashipDropsGate = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  if (!isTentashipDropsEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  await next();
});
