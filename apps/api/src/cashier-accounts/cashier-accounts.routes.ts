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
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { ManagedCashierService, MAX_ASSIGNED_BRANCHES } from './managed-cashier.service';
import { signAdminReauthProof, verifyAdminReauthProof } from './credentials';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };

/**
 * CASHIER-AUTH-02A: business-scoped administration of managed cashier accounts.
 *
 * These are ORDINARY staff routes (web token + X-Business-Id). They are not on the cashier token's allow-list, so no cashier
 * session can ever reach them, whatever it sends. Every call is pinned to the business that resolveTenantContext proved the
 * caller belongs to; the business id is never read from the body or the URL. Permission: `cashier:manage` with business-wide
 * access (Owner and Admin by default, never granted to a Manager unless the Owner does so). Every mutation additionally needs a
 * fresh administrator re-authentication proof (D-5, 5 minutes): password re-entry, NOT multi-factor authentication.
 */
export const cashierAccountRoutes = new Hono<Env>();

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guard = [authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('cashier:manage')] as const;

/** Rejects a missing, expired, foreign-user or foreign-business re-authentication proof. An impersonation session never qualifies. */
const requireFreshReauth = createMiddleware<Env>(async (c, next) => {
  const proof = c.req.header('x-reauth-proof');
  const valid = !c.get('impersonatedBy') && (await verifyAdminReauthProof(proof, c.get('userId'), c.get('businessId'), c.env.JWT_ACCESS_SECRET));
  if (!valid) {
    throw new AppError('Re-enter your password to continue.', 403, 'REAUTH_REQUIRED');
  }
  await next();
});

const mutate = [...guard, requireFreshReauth] as const;
const idParam = (raw: string) => {
  if (!ID.test(raw)) throw new AppError('Cashier account not found.', 404, 'CASHIER_ACCOUNT_NOT_FOUND');
  return raw;
};

async function withService<T>(c: Context<Env> | { readonly env: unknown; readonly executionCtx: { waitUntil(p: Promise<unknown>): void } }, fn: (s: ManagedCashierService) => Promise<T>): Promise<T> {
  const env = c.env as Bindings;
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    return await fn(new ManagedCashierService(db, createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER)));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

const reauthSchema = z.object({ password: z.string().min(1).max(256) });
const accessModeSchema = z.enum(['single', 'multiple']);
const branchIdsSchema = z.array(z.uuid()).min(1).max(MAX_ASSIGNED_BRANCHES);
// `branchId` (one branch) stays accepted so the 02A request shape keeps working; `branchIds` + `accessMode` is the 02B shape.
const createSchema = z.object({
  username: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(120),
  branchId: z.uuid().optional(),
  branchIds: branchIdsSchema.optional(),
  accessMode: accessModeSchema.optional(),
  password: z.string().min(1).max(256),
}).refine((b) => (b.branchId === undefined) !== (b.branchIds === undefined), { error: 'Send either branchId or branchIds.' });
const branchesSchema = z.object({ accessMode: accessModeSchema, branchIds: branchIdsSchema });
const passwordSchema = z.object({ password: z.string().min(1).max(256) });
const usernameSchema = z.object({ username: z.string().trim().min(1).max(64) });

// The re-authentication endpoint. Keyed by the authenticated user (mounted after authenticate), never by a body field.
cashierAccountRoutes.post('/reauth', authenticate, adminReauthRateLimit(), resolveTenantContext, requireBusinessWideAccess, requirePermission('cashier:manage'), async (c) => {
  if (c.get('impersonatedBy')) throw new AppError('Re-authentication is not available in an impersonation session.', 403, 'REAUTH_REQUIRED');
  const body = await parseJsonBody(c.req.raw, reauthSchema);
  const good = await withService(c, (s) => s.verifyAdministratorPassword(c.get('userId'), body.password));
  if (!good) throw new AppError('The password is incorrect.', 401, 'INVALID_CREDENTIALS');
  const { proof, expiresAt } = await signAdminReauthProof(c.get('userId'), c.get('businessId'), c.env.JWT_ACCESS_SECRET);
  return ok(c, { proof, expiresAt });
});

cashierAccountRoutes.get('/', ...guard, async (c) => ok(c, await withService(c, (s) => s.listAccounts(c.get('businessId')))));

cashierAccountRoutes.get('/business-code', ...guard, async (c) => ok(c, await withService(c, (s) => s.getBusinessCode(c.get('businessId')))));

// The owner chooses the password; it is never returned, never stored in plaintext and never logged. The business code is permanent.
cashierAccountRoutes.post('/', ...mutate, async (c) => {
  const body = await parseJsonBody(c.req.raw, createSchema);
  const branchIds = body.branchIds ?? [body.branchId as string];
  const accessMode = body.accessMode ?? (branchIds.length === 1 ? 'single' : 'multiple');
  const result = await withService(c, (s) => s.createAccount({
    businessId: c.get('businessId'), actorUserId: c.get('userId'), username: body.username, displayName: body.displayName,
    branchIds, accessMode, password: body.password,
  }));
  c.header('Cache-Control', 'no-store');
  return ok(c, result, 201);
});

cashierAccountRoutes.put('/:id/branches', ...mutate, async (c) => {
  const body = await parseJsonBody(c.req.raw, branchesSchema);
  return ok(c, await withService(c, (s) => s.setBranchAssignments({
    businessId: c.get('businessId'), accountId: idParam(c.req.param('id')), actorUserId: c.get('userId'),
    accessMode: body.accessMode, branchIds: body.branchIds,
  })));
});

cashierAccountRoutes.post('/:id/reset-credential', ...mutate, async (c) => {
  const body = await parseJsonBody(c.req.raw, passwordSchema);
  const result = await withService(c, (s) => s.resetCredential({ businessId: c.get('businessId'), accountId: idParam(c.req.param('id')), actorUserId: c.get('userId'), password: body.password }));
  c.header('Cache-Control', 'no-store');
  return ok(c, result);
});

cashierAccountRoutes.patch('/:id/username', ...mutate, async (c) => {
  const body = await parseJsonBody(c.req.raw, usernameSchema);
  return ok(c, await withService(c, (s) => s.changeUsername({ businessId: c.get('businessId'), accountId: idParam(c.req.param('id')), actorUserId: c.get('userId'), username: body.username })));
});

for (const action of ['disable', 'enable', 'revoke'] as const) {
  cashierAccountRoutes.post(`/:id/${action}`, ...mutate, async (c) =>
    ok(c, await withService(c, (s) => s.setStatus({ businessId: c.get('businessId'), accountId: idParam(c.req.param('id')), actorUserId: c.get('userId'), action }))),
  );
}

cashierAccountRoutes.post('/:id/revoke-sessions', ...mutate, async (c) =>
  ok(c, await withService(c, (s) => s.revokeSessions({ businessId: c.get('businessId'), accountId: idParam(c.req.param('id')), actorUserId: c.get('userId') }))),
);
