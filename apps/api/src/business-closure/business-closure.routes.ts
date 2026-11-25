import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { adminReauthRateLimit } from '../middleware/rate-limit';
import type { AuditVariables } from '../middleware/audit';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { ManagedCashierService } from '../cashier-accounts/managed-cashier.service';
import { signAdminReauthProof, verifyAdminReauthProof } from '../cashier-accounts/credentials';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { notifyOps } from '../lib/ops-alert';
import { BusinessClosureService } from './business-closure.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };

/** A closure proof is its own type: a cashier-administration proof can never authorise a closure request, and vice versa. */
export const CLOSURE_REAUTH_TYPE = 'business_closure_reauth';

/**
 * BIZ-CLOSE-01: the owner's closure REQUEST. Ordinary staff routes (web token + X-Business-Id): a cashier token is never on these paths'
 * allow-list. Owner-only by permission (`business:delete`: Owner by default, never Admin or Manager) and business-wide access. Filing and
 * withdrawing need a fresh password re-entry proof (5 minutes, bound to the user and business) and, to file, the typed business name.
 * Nothing is deleted or changed: the request is recorded, audited and raised to platform operations. Processing is blocked (see service).
 */
export const businessClosureRoutes = new Hono<Env>();

const guard = [authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('business:delete')] as const;

const requireClosureReauth = createMiddleware<Env>(async (c, next) => {
  const valid = !c.get('impersonatedBy')
    && (await verifyAdminReauthProof(c.req.header('x-reauth-proof'), c.get('userId'), c.get('businessId'), c.env.JWT_ACCESS_SECRET, CLOSURE_REAUTH_TYPE));
  if (!valid) throw new AppError('Re-enter your password to continue.', 403, 'REAUTH_REQUIRED');
  await next();
});

async function withDb<T>(c: Context<Env>, fn: (db: Awaited<ReturnType<typeof createDb>>['db']) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}
const auditCtx = (c: Context<Env>) => ({
  actorUserId: c.get('userId'), ipAddress: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null,
});

const reauthSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const fileSchema = z.object({ confirmBusinessName: z.string().min(1).max(200) }).strict();

businessClosureRoutes.post('/reauth', authenticate, adminReauthRateLimit(), resolveTenantContext, requireBusinessWideAccess, requirePermission('business:delete'), async (c) => {
  if (c.get('impersonatedBy')) throw new AppError('Re-authentication is not available in an impersonation session.', 403, 'REAUTH_REQUIRED');
  const body = await parseJsonBody(c.req.raw, reauthSchema);
  const good = await withDb(c, (db) =>
    new ManagedCashierService(db, createDurableObjectPbkdf2Worker(c.env.PASSWORD_HASHER)).verifyAdministratorPassword(c.get('userId'), body.password));
  if (!good) throw new AppError('The password is incorrect.', 401, 'INVALID_CREDENTIALS');
  const { proof, expiresAt } = await signAdminReauthProof(c.get('userId'), c.get('businessId'), c.env.JWT_ACCESS_SECRET, CLOSURE_REAUTH_TYPE);
  c.header('Cache-Control', 'no-store');
  return ok(c, { proof, expiresAt });
});

businessClosureRoutes.get('/', ...guard, async (c) => {
  c.header('Cache-Control', 'no-store');
  return ok(c, await withDb(c, (db) => new BusinessClosureService(db).status(c.get('businessId'))));
});

businessClosureRoutes.post('/requests', ...guard, requireClosureReauth, async (c) => {
  const body = await parseJsonBody(c.req.raw, fileSchema);
  const result = await withDb(c, (db) => new BusinessClosureService(db).file(c.get('businessId'), body.confirmBusinessName, auditCtx(c)));
  c.set('auditAlreadyRecorded', true);
  if (result.created) {
    // Ids only: this leaves the platform for a third-party destination (see lib/ops-alert.ts).
    c.executionCtx.waitUntil(notifyOps(c.env, {
      event: 'business.closure_requested', severity: 'warning',
      message: 'A business owner requested account closure. Review it; nothing has been deleted or changed.',
      detail: { requestId: result.request.id, businessId: c.get('businessId') },
    }));
  }
  c.header('Cache-Control', 'no-store');
  return ok(c, result, result.created ? 201 : 200);
});

businessClosureRoutes.post('/requests/withdraw', ...guard, requireClosureReauth, async (c) => {
  const request = await withDb(c, (db) => new BusinessClosureService(db).withdraw(c.get('businessId'), auditCtx(c)));
  c.set('auditAlreadyRecorded', true);
  c.header('Cache-Control', 'no-store');
  return ok(c, { request });
});
