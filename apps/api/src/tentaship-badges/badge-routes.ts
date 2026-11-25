import { Hono, type Context } from 'hono';
import { COMMUNITY_HUB_PERMISSIONS } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { requireAnyPermission } from '../middleware/require-permission';
import { ok } from '../lib/response';
import { tentashipBadgesGate } from './badge-gate';
import { BadgeAwardService } from './badge-award.service';

async function withService<T>(c: Context, fn: (s: BadgeAwardService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb((c.env as Bindings).HYPERDRIVE);
  try {
    return await fn(new BadgeAwardService(db));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}
const ctxOf = (c: Context) => ({ ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null });

/**
 * TB-03 customer badges. Gate first (generic 404 unless TENTASHIP_BADGES_ENABLED === 'true'), then customer authentication. The customer reads
 * ONLY their own current badges and may ask the SERVER to evaluate their own evidence; the request carries no input, so nothing the client
 * sends can influence an award. Badges are not points: no balance, value or transfer is exposed.
 */
export const customerTentashipBadgeRoutes = new Hono<{ Bindings: Bindings; Variables: CustomerAuthVariables }>();
customerTentashipBadgeRoutes.use('*', tentashipBadgesGate, customerAuthenticate, rateLimitByCustomer());

customerTentashipBadgeRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, { badges: await withService(c, (s) => s.listEarned('customer', c.get('customerId'))) });
});

customerTentashipBadgeRoutes.post('/evaluate', async (c) => {
  const awarded = await withService(c, (s) => s.evaluate('customer', c.get('customerId'), ctxOf(c)));
  c.header('Cache-Control', 'no-store');
  return ok(c, { awarded, badges: await withService(c, (s) => s.listEarned('customer', c.get('customerId'))) });
});

/**
 * TB-03 business badges. Gate first, then the same business-wide hub guard as the business Community routes. A business sees ONLY its own
 * badges. A cashier token is on no allow-list for these paths.
 */
export const businessTentashipBadgeRoutes = new Hono<{ Bindings: Bindings; Variables: AuthVariables & TenantVariables }>();
businessTentashipBadgeRoutes.use('*', tentashipBadgesGate, authenticate, resolveTenantContext, requireBusinessWideAccess, requireAnyPermission(COMMUNITY_HUB_PERMISSIONS));

businessTentashipBadgeRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, { badges: await withService(c, (s) => s.listEarned('business', c.get('businessId'))) });
});

businessTentashipBadgeRoutes.post('/evaluate', async (c) => {
  const awarded = await withService(c, (s) => s.evaluate('business', c.get('businessId'), { actorUserId: c.get('userId'), ...ctxOf(c) }));
  c.header('Cache-Control', 'no-store');
  return ok(c, { awarded, badges: await withService(c, (s) => s.listEarned('business', c.get('businessId'))) });
});
