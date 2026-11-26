import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { isTentashipShuffleEnabled } from './shuffle-flag';

/** Mounted FIRST on every Shuffle route: generic 404 before authentication unless TENTASHIP_SHUFFLE_ENABLED is exactly "true". */
export const tentashipShuffleGate = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  if (!isTentashipShuffleEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  await next();
});
