import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { isTentashipBadgesEnabled } from './badge-flag';

/**
 * TB-02 runtime containment: mounted FIRST on every badge route (customer, business and platform). When the control is not exactly "true" the
 * route answers the generic 404 of an unmounted route, BEFORE authentication, so nothing about badges is discoverable, readable or writable.
 */
export const tentashipBadgesGate = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  if (!isTentashipBadgesEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  await next();
});
