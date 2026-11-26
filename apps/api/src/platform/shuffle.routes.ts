import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { tentashipShuffleGate } from '../shuffle/shuffle-gate';
import { ShuffleCampaignService } from '../shuffle/shuffle-campaign.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

/**
 * TSH-03: platform administration of Tentaship Shuffle campaign CONFIGURATION. Platform `admin` only; every path is a generic 404 unless
 * TENTASHIP_SHUFFLE_ENABLED is exactly "true" (gate before authentication). There is NO participation, publication, invitation, selection or reward route:
 * none exists in this block. A cashier token is on no allow-list for these paths.
 */
export const platformShuffleRoutes = new Hono<Env>();
platformShuffleRoutes.use('*', tentashipShuffleGate, authenticate, requirePlatformRole(['admin']));

const iso = z.string().datetime();
const contentShape = {
  qualificationRuleVersionId: z.uuid(), minParticipants: z.number().int(), maxCapacity: z.number().int(),
  qualificationWindowStart: iso, qualificationWindowEnd: iso, entryAcceptanceDeadline: iso,
  disclosure: z.record(z.string().min(2).max(5), z.string().min(1).max(2000)), termsVersion: z.string().min(1).max(64),
  closureConditions: z.string().min(1).max(1000), cancellationConditions: z.string().min(1).max(1000),
};
const contentSchema = z.object(contentShape).strict();
const createSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/), mode: z.enum(['guaranteed', 'limited']), ...contentShape }).strict();
const statusSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const snapshotSchema = z.object({ customerId: z.uuid() }).strict();
const toContent = (b: z.infer<typeof contentSchema>) => ({
  ...b, qualificationWindowStart: new Date(b.qualificationWindowStart), qualificationWindowEnd: new Date(b.qualificationWindowEnd), entryAcceptanceDeadline: new Date(b.entryAcceptanceDeadline),
});
const idOf = (c: Context<Env>) => {
  const p = z.uuid().safeParse(c.req.param('id'));
  if (!p.success) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  return p.data;
};
const actor = (c: Context<Env>) => ({ actorUserId: c.get('userId') as string, ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null });
async function withService<T>(c: Context<Env>, fn: (s: ShuffleCampaignService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return await fn(new ShuffleCampaignService(db)); } finally { c.executionCtx.waitUntil(close()); }
}

platformShuffleRoutes.get('/campaigns', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withService(c, (s) => s.list())); });
platformShuffleRoutes.post('/campaigns', async (c) => {
  const b = await parseJsonBody(c.req.raw, createSchema);
  const { key, mode, ...rest } = b;
  const r = await withService(c, (s) => s.createCampaign({ key, mode, ...toContent(rest) }, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, r, 201);
});
platformShuffleRoutes.post('/campaigns/:id/versions', async (c) => {
  const b = await parseJsonBody(c.req.raw, contentSchema);
  const r = await withService(c, (s) => s.createVersion(idOf(c), toContent(b), actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, r, 201);
});
for (const [path, target] of [['suspend', 'suspended'], ['cancel', 'cancelled']] as const) {
  platformShuffleRoutes.post(`/campaigns/:id/${path}`, async (c) => {
    const b = await parseJsonBody(c.req.raw, statusSchema);
    const r = await withService(c, (s) => s.setStatus(idOf(c), target, b.reason, actor(c)));
    c.set('auditAlreadyRecorded', true);
    return ok(c, r);
  });
}
platformShuffleRoutes.post('/campaigns/:id/resume', async (c) => {
  const r = await withService(c, (s) => s.setStatus(idOf(c), 'draft', null, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, r);
});
platformShuffleRoutes.post('/versions/:id/snapshots', async (c) => {
  const b = await parseJsonBody(c.req.raw, snapshotSchema);
  const r = await withService(c, (s) => s.takeEligibilitySnapshot(idOf(c), b.customerId, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, { qualified: r.snapshot.qualified, created: r.created, evaluatedAt: r.snapshot.evaluatedAt.toISOString() }, r.created ? 201 : 200);
});
platformShuffleRoutes.get('/versions/:id/snapshots', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withService(c, (s) => s.snapshotCounts(idOf(c)))); });
