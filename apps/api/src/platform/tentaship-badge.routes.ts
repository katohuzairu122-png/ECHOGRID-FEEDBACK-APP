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
import { tentashipBadgesGate } from '../tentaship-badges/badge-gate';
import { BadgeDefinitionService } from '../tentaship-badges/badge-definition.service';
import { BadgeAwardService, REVOCATION_REASONS } from '../tentaship-badges/badge-award.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

/**
 * TB-02: platform administration of Tentaship Badges definitions. Platform `admin` only. Every path answers a generic 404 unless
 * TENTASHIP_BADGES_ENABLED is exactly "true" (gate runs BEFORE authentication). Definitions award nothing by themselves.
 */
export const platformTentashipBadgeRoutes = new Hono<Env>();
platformTentashipBadgeRoutes.use('*', tentashipBadgesGate, authenticate, requirePlatformRole(['admin']));

const text = z.record(z.string().min(2).max(5), z.string().min(1).max(400));
const contentSchema = z.object({ names: text, descriptions: text.default({}), rule: z.unknown() }).strict();
const createSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/), participantType: z.enum(['customer', 'business']),
  names: text, descriptions: text.default({}), rule: z.unknown(),
}).strict();
const uuid = (c: Context<Env>, name: string) => {
  const p = z.uuid().safeParse(c.req.param(name));
  if (!p.success) throw new AppError('Badge not found.', 404, 'BADGE_NOT_FOUND');
  return p.data;
};
const actor = (c: Context<Env>) => ({
  actorUserId: c.get('userId') as string, ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null,
});
async function withService<T>(c: Context<Env>, fn: (s: BadgeDefinitionService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(new BadgeDefinitionService(db));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

platformTentashipBadgeRoutes.get('/definitions', async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, await withService(c, (s) => s.list()));
});

platformTentashipBadgeRoutes.post('/definitions', async (c) => {
  const body = await parseJsonBody(c.req.raw, createSchema);
  const result = await withService(c, (s) => s.createDefinition(body, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, result, 201);
});

platformTentashipBadgeRoutes.post('/definitions/:id/versions', async (c) => {
  const body = await parseJsonBody(c.req.raw, contentSchema);
  const row = await withService(c, (s) => s.createVersion(uuid(c, 'id'), body, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, row, 201);
});

for (const action of ['activate', 'retire'] as const) {
  platformTentashipBadgeRoutes.post(`/versions/:id/${action}`, async (c) => {
    const row = await withService(c, (s) => s[action](uuid(c, 'id'), actor(c)));
    c.set('auditAlreadyRecorded', true);
    return ok(c, row);
  });
}

const revokeSchema = z.object({ reasonCode: z.enum(REVOCATION_REASONS), note: z.string().trim().min(1).max(500) }).strict();
async function withAwards<T>(c: Context<Env>, fn: (s: BadgeAwardService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(new BadgeAwardService(db));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

/** Award history for audit (aggregate evidence only). */
platformTentashipBadgeRoutes.get('/awards', async (c) => {
  const limit = Number(new URL(c.req.url).searchParams.get('limit')) || 50;
  c.header('Cache-Control', 'no-store');
  return ok(c, await withAwards(c, (s) => s.history(limit)));
});

/** Approved revocation: records a reason and the authorising admin; the award stays in the ledger. Idempotent. */
platformTentashipBadgeRoutes.post('/awards/:id/revoke', async (c) => {
  const body = await parseJsonBody(c.req.raw, revokeSchema);
  const result = await withAwards(c, (s) => s.revoke(uuid(c, 'id'), body.reasonCode, body.note, actor(c)));
  c.set('auditAlreadyRecorded', true);
  return ok(c, result);
});
