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
import { ShuffleParticipationService } from '../shuffle/shuffle-participation.service';
import { SHUFFLE_METRIC_DEFINITIONS, TentashipAnalytics } from '../analytics/tentaship-analytics';

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

/**
 * TSH-05 / TSH-04 SYNTHETIC HARNESS. Platform-admin only, behind the same control. These routes act on behalf of SYNTHETIC customers for isolated
 * verification: the database fixes synthetic = true on every row and versions are never released, so they can never carry real participation. There is
 * no customer-facing route. Every call must state `syntheticAcknowledged: true`.
 */
const synth = z.literal(true);
const issueSchema = z.object({ syntheticAcknowledged: synth, customerId: z.uuid(), expiresAt: iso }).strict();
const ackSchema = z.object({ syntheticAcknowledged: synth }).strict();
const acceptSchema = z.object({ syntheticAcknowledged: synth, termsVersion: z.string().min(1).max(64), disclosureHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const reasonSchema = z.object({ syntheticAcknowledged: synth, reason: z.string().trim().min(1).max(500) }).strict();
const selectionSchema = z.object({ syntheticAcknowledged: synth, winnerCount: z.number().int().min(1) }).strict();
async function withParticipation<T>(c: Context<Env>, fn: (s: ShuffleParticipationService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return await fn(new ShuffleParticipationService(db)); } finally { c.executionCtx.waitUntil(close()); }
}
platformShuffleRoutes.post('/versions/:id/synthetic/invitations', async (c) => {
  const b = await parseJsonBody(c.req.raw, issueSchema);
  const r = await withParticipation(c, (s) => s.issueInvitation(idOf(c), b.customerId, new Date(b.expiresAt), actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, { id: r.invitation.id, status: r.invitation.status, created: r.created }, r.created ? 201 : 200);
});
platformShuffleRoutes.post('/versions/:id/synthetic/expire', async (c) => {
  await parseJsonBody(c.req.raw, ackSchema);
  c.set('auditAlreadyRecorded', true);
  return ok(c, await withParticipation(c, (s) => s.expireDue(idOf(c), actor(c))));
});
platformShuffleRoutes.post('/versions/:id/synthetic/selection', async (c) => {
  const b = await parseJsonBody(c.req.raw, selectionSchema);
  const r = await withParticipation(c, (s) => s.runSyntheticSelection(idOf(c), b.winnerCount, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, { created: r.created, entrantCount: r.result.entrantCount, winnerCount: r.result.winnerCount, inputCommitment: r.result.inputCommitment, resultCommitment: r.result.resultCommitment }, r.created ? 201 : 200);
});
platformShuffleRoutes.get('/versions/:id/evidence', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withParticipation(c, (s) => s.verifyEvidence(idOf(c)))); });
platformShuffleRoutes.get('/versions/:id/participation-counts', async (c) => { c.header('Cache-Control', 'no-store'); return ok(c, await withParticipation(c, (s) => s.counts(idOf(c)))); });
for (const op of ['view', 'decline'] as const) {
  platformShuffleRoutes.post(`/invitations/:id/synthetic/${op}`, async (c) => {
    await parseJsonBody(c.req.raw, ackSchema);
    c.set('auditAlreadyRecorded', true);
    return ok(c, await withParticipation(c, (s) => (op === 'view' ? s.markViewed(idOf(c), actor(c)) : s.decline(idOf(c), actor(c)))));
  });
}
platformShuffleRoutes.post('/invitations/:id/synthetic/accept', async (c) => {
  const b = await parseJsonBody(c.req.raw, acceptSchema);
  const r = await withParticipation(c, (s) => s.accept(idOf(c), { termsVersion: b.termsVersion, disclosureHash: b.disclosureHash }, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, { entryId: r.entry.id, status: r.entry.status, created: r.created }, r.created ? 201 : 200);
});
platformShuffleRoutes.post('/invitations/:id/synthetic/withdraw', async (c) => {
  const b = await parseJsonBody(c.req.raw, reasonSchema);
  c.set('auditAlreadyRecorded', true);
  return ok(c, await withParticipation(c, (s) => s.withdraw(idOf(c), b.reason, actor(c))));
});
platformShuffleRoutes.post('/entries/:id/synthetic/cancel', async (c) => {
  const b = await parseJsonBody(c.req.raw, reasonSchema);
  c.set('auditAlreadyRecorded', true);
  return ok(c, await withParticipation(c, (s) => s.cancelEntry(idOf(c), b.reason, actor(c))));
});

/** TSH-07: aggregate, definition-backed analytics for a campaign version (platform admin). Unsupported metrics are explicitly unavailable, never zero. */
platformShuffleRoutes.get('/versions/:id/analytics', async (c) => {
  c.header('Cache-Control', 'no-store');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return ok(c, await new TentashipAnalytics(db).shuffleVersion(idOf(c), { includeGovernance: true })); } finally { c.executionCtx.waitUntil(close()); }
});
platformShuffleRoutes.get('/metric-definitions', (c) => { c.header('Cache-Control', 'no-store'); return ok(c, SHUFFLE_METRIC_DEFINITIONS); });
