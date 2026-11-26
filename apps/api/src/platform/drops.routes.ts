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
import { tentashipDropsGate } from '../drops/drops-gate';
import { DropSponsorshipService } from '../drops/drop-sponsorship.service';
import { DROP_METRIC_DEFINITIONS, DROP_METRIC_KINDS, TentashipAnalytics } from '../analytics/tentaship-analytics';
import { checkDropInventory } from '../analytics/drop-inventory-reconciliation';
import { dropEventReferences } from '../analytics/drop-event-references';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

/**
 * TDP-02: platform administration and SYNTHETIC HARNESS for Tentaship Drops. Platform `admin` only; every path is a generic 404 unless
 * TENTASHIP_DROPS_ENABLED is exactly "true" (gate before authentication). There is no sponsor-facing, customer-facing or payment route: sponsor
 * and customer interfaces need the Owner's sponsor-onboarding and permission decisions. Mutating calls state `syntheticAcknowledged: true`.
 */
export const platformDropsRoutes = new Hono<Env>();
platformDropsRoutes.use('*', tentashipDropsGate, authenticate, requirePlatformRole(['admin']));

const iso = z.string().datetime();
const ack = { syntheticAcknowledged: z.literal(true) };
const content = {
  productName: z.string().min(1).max(120), description: z.string().min(1).max(1000), quantityTotal: z.number().int(), collectionMethod: z.string().min(1).max(300), collectionLocation: z.string().min(1).max(300),
  collectionWindowStart: iso, collectionWindowEnd: iso, offerExpiresAt: iso, qualificationRuleVersionId: z.uuid(),
};
const toContent = <T extends { collectionWindowStart: string; collectionWindowEnd: string; offerExpiresAt: string }>(b: T) => ({ ...b, collectionWindowStart: new Date(b.collectionWindowStart), collectionWindowEnd: new Date(b.collectionWindowEnd), offerExpiresAt: new Date(b.offerExpiresAt) });
const createSchema = z.object({ ...ack, key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/), businessId: z.uuid(), ...content }).strict();
const versionSchema = z.object({ ...ack, ...content }).strict();
const reasonSchema = z.object({ ...ack, reason: z.string().trim().min(1).max(500) }).strict();
const plainSchema = z.object(ack).strict();
const reserveSchema = z.object({ ...ack, customerId: z.uuid(), holdExpiresAt: iso }).strict();
const idOf = (c: Context<Env>) => { const p = z.uuid().safeParse(c.req.param('id')); if (!p.success) throw new AppError('Not found.', 404, 'NOT_FOUND'); return p.data; };
const actor = (c: Context<Env>) => ({ actorUserId: c.get('userId') as string, ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null });
async function withService<T>(c: Context<Env>, fn: (s: DropSponsorshipService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return await fn(new DropSponsorshipService(db)); } finally { c.executionCtx.waitUntil(close()); }
}
const done = (c: Context<Env>) => c.set('auditAlreadyRecorded', true);

platformDropsRoutes.post('/sponsorships', async (c) => {
  const { syntheticAcknowledged: _a, ...b } = await parseJsonBody(c.req.raw, createSchema);
  const r = await withService(c, (s) => s.create({ ...toContent(b) }, actor(c)));
  done(c); return ok(c, { id: r.sponsorship.id, status: r.sponsorship.status, versionId: r.version.id }, 201);
});
platformDropsRoutes.post('/sponsorships/:id/versions', async (c) => {
  const { syntheticAcknowledged: _a, ...b } = await parseJsonBody(c.req.raw, versionSchema);
  const r = await withService(c, (s) => s.addVersion(idOf(c), toContent(b), actor(c)));
  done(c); return ok(c, { id: r.id, version: r.version }, 201);
});
const moves = { submit: 'submitted', 'start-review': 'under_review', approve: 'approved', schedule: 'scheduled', open: 'available', expire: 'expired' } as const;
for (const [path, target] of Object.entries(moves)) {
  platformDropsRoutes.post(`/sponsorships/:id/${path}`, async (c) => {
    await parseJsonBody(c.req.raw, plainSchema);
    const r = await withService(c, (s) => s.move(idOf(c), target, actor(c)));
    done(c); return ok(c, { status: r.sponsorship.status, changed: r.changed });
  });
}
const reasoned = { suspend: 'suspended', cancel: 'cancelled', 'return-to-draft': 'draft' } as const;
for (const [path, target] of Object.entries(reasoned)) {
  platformDropsRoutes.post(`/sponsorships/:id/${path}`, async (c) => {
    const b = await parseJsonBody(c.req.raw, reasonSchema);
    const r = await withService(c, (s) => s.move(idOf(c), target, actor(c), { reason: b.reason }));
    done(c); return ok(c, { status: r.sponsorship.status, changed: r.changed });
  });
}
platformDropsRoutes.post('/sponsorships/:id/resume', async (c) => {
  await parseJsonBody(c.req.raw, plainSchema);
  const r = await withService(c, (s) => s.move(idOf(c), 'available', actor(c)));
  done(c); return ok(c, { status: r.sponsorship.status, changed: r.changed });
});
platformDropsRoutes.post('/sponsorships/:id/synthetic/reservations', async (c) => {
  const b = await parseJsonBody(c.req.raw, reserveSchema);
  const r = await withService(c, (s) => s.reserve(idOf(c), b.customerId, new Date(b.holdExpiresAt), actor(c)));
  done(c); return ok(c, { id: r.reservation.id, status: r.reservation.status, created: r.created }, r.created ? 201 : 200);
});
platformDropsRoutes.post('/sponsorships/:id/synthetic/expire-due', async (c) => {
  await parseJsonBody(c.req.raw, plainSchema);
  done(c); return ok(c, await withService(c, (s) => s.expireDue(idOf(c), actor(c))));
});
platformDropsRoutes.post('/reservations/:id/synthetic/allocate', async (c) => {
  await parseJsonBody(c.req.raw, plainSchema);
  const r = await withService(c, (s) => s.allocate(idOf(c), actor(c)));
  done(c); return ok(c, { status: r.status });
});
platformDropsRoutes.post('/reservations/:id/synthetic/collect', async (c) => {
  await parseJsonBody(c.req.raw, plainSchema);
  done(c); return ok(c, await withService(c, (s) => s.collect(idOf(c), actor(c))));
});
platformDropsRoutes.post('/reservations/:id/synthetic/release', async (c) => {
  const b = await parseJsonBody(c.req.raw, reasonSchema);
  done(c); return ok(c, await withService(c, (s) => s.release(idOf(c), b.reason, actor(c))));
});
platformDropsRoutes.get('/sponsorships/:id/evidence', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withService(c, (s) => s.verifyEvidence(idOf(c)))); });
platformDropsRoutes.get('/businesses/:id/sponsorships', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withService(c, (s) => s.listForBusiness(idOf(c)))); });

/** TDP-04: internal sponsorship analytics (platform admin). NO sponsor-facing analytics route exists until the Owner approves the sponsor permission model. */
platformDropsRoutes.get('/sponsorships/:id/analytics', async (c) => {
  c.header('Cache-Control', 'no-store');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return ok(c, await new TentashipAnalytics(db).dropSponsorship(idOf(c))); } finally { c.executionCtx.waitUntil(close()); }
});
platformDropsRoutes.get('/metric-definitions', (c) => { c.header('Cache-Control', 'no-store'); return ok(c, DROP_METRIC_DEFINITIONS); });

/**
 * TDP-04: canonical inventory reconciliation (READ-ONLY: it reports, it never repairs) and identity-free event references for TSH-07. Platform admin only, behind the Drops
 * control; there is no export, sponsor-facing or write route here.
 */
platformDropsRoutes.get('/sponsorships/:id/reconciliation', async (c) => {
  c.header('Cache-Control', 'no-store');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return ok(c, await checkDropInventory(db, idOf(c))); } finally { c.executionCtx.waitUntil(close()); }
});
platformDropsRoutes.get('/sponsorships/:id/event-references', async (c) => {
  c.header('Cache-Control', 'no-store');
  const after = z.coerce.number().int().min(0).safeParse(c.req.query('afterSeq') ?? '0');
  if (!after.success) throw new AppError('afterSeq must be a non-negative whole number.', 422, 'VALIDATION_ERROR');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return ok(c, await dropEventReferences(db, idOf(c), { afterSeq: after.data })); } finally { c.executionCtx.waitUntil(close()); }
});
platformDropsRoutes.get('/metric-kinds', (c) => { c.header('Cache-Control', 'no-store'); return ok(c, DROP_METRIC_KINDS); });
