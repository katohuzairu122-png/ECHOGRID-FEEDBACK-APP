import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { isTentashipShuffleEnabled } from '../shuffle/shuffle-flag';
import { isTentashipDropsEnabled } from '../drops/drops-flag';
import { ShuffleDropAllocationService } from '../shuffle/shuffle-drop-allocation.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

/** TSH-04: synthetic selection -> allocation orchestration. Needs BOTH TENTASHIP_SHUFFLE_ENABLED and TENTASHIP_DROPS_ENABLED to be exactly "true" (generic 404 before authentication otherwise). Platform admin only. */
const bothGate = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  if (!isTentashipShuffleEnabled(c.env) || !isTentashipDropsEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  await next();
});
export const platformShuffleDropRoutes = new Hono<Env>();
platformShuffleDropRoutes.use('*', bothGate, authenticate, requirePlatformRole(['admin']));

const allocateSchema = z.object({ sponsorshipId: z.uuid(), holdExpiresAt: z.string().datetime() }).strict();
const idOf = (c: Context<Env>) => {
  const p = z.uuid().safeParse(c.req.param('id'));
  if (!p.success) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  return p.data;
};
async function withService<T>(c: Context<Env>, fn: (s: ShuffleDropAllocationService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return await fn(new ShuffleDropAllocationService(db)); } finally { c.executionCtx.waitUntil(close()); }
}

platformShuffleDropRoutes.post('/versions/:id/synthetic/allocate-to-drop', async (c) => {
  const b = await parseJsonBody(c.req.raw, allocateSchema);
  const r = await withService(c, (s) => s.allocateSelected(idOf(c), b.sponsorshipId, new Date(b.holdExpiresAt), { actorUserId: c.get('userId') as string, ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null }));
  c.set('auditAlreadyRecorded', true);
  return ok(c, r);
});
/** Identity-free lifecycle counts: selected / linked / allocated / collected / expired / released. */
platformShuffleDropRoutes.get('/versions/:id/status', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withService(c, (s) => s.status(idOf(c)))); });
