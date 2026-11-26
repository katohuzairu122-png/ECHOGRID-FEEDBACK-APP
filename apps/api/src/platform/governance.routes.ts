import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
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
import { GovernanceService } from '../governance/governance.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

/**
 * TSH-08: synthetic governance cases for Shuffle and Drops subjects. A generic 404 before authentication unless AT LEAST ONE of the two controls is exactly
 * "true"; a case about a Shuffle subject additionally needs TENTASHIP_SHUFFLE_ENABLED and about a Drops subject TENTASHIP_DROPS_ENABLED (checked in the service),
 * so enabling one feature never opens the other. Platform admin only. There is NO route that assigns operators (that is an Owner grant) and no unrestricted override.
 */
export const platformGovernanceRoutes = new Hono<Env>();
const gate = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  if (!isTentashipShuffleEnabled(c.env) && !isTentashipDropsEnabled(c.env)) throw new AppError('Not found.', 404, 'NOT_FOUND');
  await next();
});
platformGovernanceRoutes.use('*', gate, authenticate, requirePlatformRole(['admin']));

const ack = { syntheticAcknowledged: z.literal(true) };
const plain = z.object(ack).strict();
const reason = z.object({ ...ack, reason: z.string().trim().min(10).max(1000) }).strict();
const openSchema = z.object({ ...ack, kind: z.enum(['fraud', 'dispute']), subjectType: z.enum(['shuffle_campaign_version', 'shuffle_entry', 'shuffle_selection', 'drop_sponsorship', 'drop_reservation']), subjectId: z.uuid(),
  classification: z.enum(['suspected_duplicate_participation', 'suspected_fabricated_evidence', 'allocation_dispute', 'collection_dispute', 'other']), summary: z.string().trim().min(1).max(1000), relatedCaseId: z.uuid().nullish() }).strict();
const evidenceSchema = z.object({ ...ack, kind: z.enum(['note', 'reference']), body: z.string().trim().min(1).max(2000) }).strict();
const decideSchema = z.object({ ...ack, decision: z.enum(['upheld', 'overturned', 'no_action']), reason: z.string().trim().min(10).max(1000) }).strict();
const overrideSchema = z.object({ ...ack, scope: z.enum(['cancel_entry_before_selection', 'release_reserved_hold']), targetId: z.uuid(), justification: z.string().trim().min(10).max(1000), expiresAt: z.string().datetime() }).strict();
const idOf = (c: Context<Env>) => { const p = z.uuid().safeParse(c.req.param('id')); if (!p.success) throw new AppError('Not found.', 404, 'NOT_FOUND'); return p.data; };
const actor = (c: Context<Env>) => ({ actorUserId: c.get('userId') as string, ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null });
async function svc<T>(c: Context<Env>, fn: (s: GovernanceService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return await fn(new GovernanceService(db, { shuffle: isTentashipShuffleEnabled(c.env), drops: isTentashipDropsEnabled(c.env) })); } finally { c.executionCtx.waitUntil(close()); }
}
const done = (c: Context<Env>) => c.set('auditAlreadyRecorded', true);
const brief = (r: { id: string; status: string }) => ({ id: r.id, status: r.status });

platformGovernanceRoutes.post('/cases', async (c) => { const { syntheticAcknowledged: _a, ...b } = await parseJsonBody(c.req.raw, openSchema); const r = await svc(c, (s) => s.openCase(b, actor(c))); done(c); return ok(c, brief(r), 201); });
platformGovernanceRoutes.get('/cases/:id', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await svc(c, (s) => s.getCase(idOf(c)))); });
platformGovernanceRoutes.get('/cases/:id/chain', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await svc(c, (s) => s.verifyChain(idOf(c)))); });
platformGovernanceRoutes.post('/cases/:id/evidence', async (c) => { const { syntheticAcknowledged: _a, ...b } = await parseJsonBody(c.req.raw, evidenceSchema); const r = await svc(c, (s) => s.submitEvidence(idOf(c), b, actor(c))); done(c); return ok(c, { id: r.id, contentHash: r.contentHash }, 201); });
platformGovernanceRoutes.post('/cases/:id/escalate', async (c) => { const b = await parseJsonBody(c.req.raw, reason); done(c); return ok(c, brief(await svc(c, (s) => s.escalate(idOf(c), b.reason, actor(c))))); });
platformGovernanceRoutes.post('/cases/:id/start-review', async (c) => { await parseJsonBody(c.req.raw, plain); done(c); return ok(c, brief(await svc(c, (s) => s.startReview(idOf(c), actor(c))))); });
platformGovernanceRoutes.post('/cases/:id/decide', async (c) => { const b = await parseJsonBody(c.req.raw, decideSchema); done(c); return ok(c, brief(await svc(c, (s) => s.decide(idOf(c), b.decision, b.reason, actor(c))))); });
platformGovernanceRoutes.post('/cases/:id/close', async (c) => { await parseJsonBody(c.req.raw, plain); done(c); return ok(c, brief(await svc(c, (s) => s.close(idOf(c), actor(c))))); });
platformGovernanceRoutes.post('/cases/:id/overrides', async (c) => { const b = await parseJsonBody(c.req.raw, overrideSchema); const r = await svc(c, (s) => s.requestOverride(idOf(c), { scope: b.scope, targetId: b.targetId, justification: b.justification, expiresAt: new Date(b.expiresAt) }, actor(c))); done(c); return ok(c, brief(r), 201); });
platformGovernanceRoutes.post('/cases/:id/expire-due', async (c) => { await parseJsonBody(c.req.raw, plain); done(c); return ok(c, await svc(c, (s) => s.expireDue(idOf(c), actor(c)))); });
platformGovernanceRoutes.post('/overrides/:id/approve', async (c) => { await parseJsonBody(c.req.raw, plain); done(c); return ok(c, brief(await svc(c, (s) => s.approveOverride(idOf(c), actor(c))))); });
platformGovernanceRoutes.post('/overrides/:id/reject', async (c) => { const b = await parseJsonBody(c.req.raw, reason); done(c); return ok(c, brief(await svc(c, (s) => s.rejectOverride(idOf(c), b.reason, actor(c))))); });
platformGovernanceRoutes.post('/overrides/:id/cancel', async (c) => { const b = await parseJsonBody(c.req.raw, reason); done(c); return ok(c, brief(await svc(c, (s) => s.cancelOverride(idOf(c), b.reason, actor(c))))); });
platformGovernanceRoutes.post('/overrides/:id/execute', async (c) => { await parseJsonBody(c.req.raw, plain); const r = await svc(c, (s) => s.executeOverride(idOf(c), actor(c))); done(c); return ok(c, { ...brief(r.override), created: r.created }); });
