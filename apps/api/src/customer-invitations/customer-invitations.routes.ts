import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { CustomerInvitationService } from './customer-invitation.service';
import { signOwnerInvitation } from './invitation-token';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };

/**
 * OWNER-INVITE-01: owner-issued customer invitations, inside the owner-facing Cashier App. ORDINARY staff routes (web token + X-Business-Id):
 * none of these paths is on the cashier token allow-list, so no cashier credential can ever reach them. Permission is the EXISTING
 * `cashier:manage` with business-wide access (Owner and Admin by default; a Manager only if the Owner granted it): no new permission is created.
 * An invitation grants nothing by itself: the customer still authenticates and gives their own join consent.
 */
export const customerInvitationRoutes = new Hono<Env>();
customerInvitationRoutes.use('*', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('cashier:manage'));

const createSchema = z.object({
  branchId: z.uuid(),
  expiresInHours: z.number().int().min(1).max(168).optional(),
  requestKey: z.string().trim().min(8).max(64).optional(),
}).strict();

async function withDb<T>(c: Context<Env>, fn: (db: Awaited<ReturnType<typeof createDb>>['db']) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return await fn(db); } finally { c.executionCtx.waitUntil(close()); }
}
const ctxOf = (c: Context<Env>) => ({ actorUserId: c.get('userId'), ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null });

customerInvitationRoutes.post('/', async (c) => {
  const body = await parseJsonBody(c.req.raw, createSchema);
  const businessId = c.get('businessId');
  const { success } = await c.env.LOOKUP_RATE_LIMITER.limit({ key: `owner-invite:${businessId}:${c.get('userId')}` });
  if (!success) throw new AppError('Too many invitations. Please try again shortly.', 429, 'RATE_LIMITED');
  const { invitation, created } = await withDb(c, (db) => new CustomerInvitationService(db).issue(businessId, body, ctxOf(c)));
  c.set('auditAlreadyRecorded', true);
  const token = await signOwnerInvitation({ invitationId: invitation.id, businessId, branchId: invitation.branchId, issuerUserId: invitation.issuedByUserId, expiresAt: invitation.expiresAt }, c.env.JWT_ACCESS_SECRET);
  c.header('Cache-Control', 'no-store');
  return ok(c, {
    id: invitation.id, branchId: invitation.branchId, expiresAt: invitation.expiresAt.toISOString(),
    inviteUrl: new URL(`/loyalty/invite/${token}`, c.env.WEB_BASE_URL).toString(),
  }, created ? 201 : 200);
});

customerInvitationRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, await withDb(c, (db) => new CustomerInvitationService(db).list(c.get('businessId'))));
});

customerInvitationRoutes.post('/:id/revoke', async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('Invitation not found.', 404, 'INVITATION_NOT_FOUND');
  const { invitation } = await withDb(c, (db) => new CustomerInvitationService(db).revoke(c.get('businessId'), id.data, ctxOf(c)));
  c.set('auditAlreadyRecorded', true);
  c.header('Cache-Control', 'no-store');
  return ok(c, { id: invitation.id, revokedAt: invitation.revokedAt?.toISOString() ?? null });
});
