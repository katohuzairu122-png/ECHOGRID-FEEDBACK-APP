import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { CASHIER_CATEGORIES, categorize, filterFor, safeReference, type CashierCategory } from './categories';
import { resolveActivityScope } from './scope';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };

/**
 * CASHIER-PWA-01 C7: business-isolated, branch-filterable cashier activity history.
 *
 * An ordinary staff route (web token + X-Business-Id), deliberately NOT on the cashier token's allow-list, so a cashier
 * session can never read history (including its own: no existing approved permission grants own-activity access, so
 * counter-only roles are denied). It reads existing audit rows only: no new persistence, no ledger or financial effect.
 *
 * Access (R5), from existing permissions only:
 *   - `audit:view` (Owner, Admin) or `loyalty:accounts:view` (Manager) may read; everyone else is refused.
 *   - Scope is the caller's authorized branches: business-wide for a business-wide grant, otherwise exactly the branches
 *     they are granted. A requested branch outside that scope is refused.
 *   - Always limited to the business that resolveTenantContext proved the caller belongs to.
 */
export const cashierActivityRoutes = new Hono<Env>();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message: string) => new AppError(message, 400, 'VALIDATION_ERROR');

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw bad(`Invalid ${name}.`);
  return d;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return btoa(`${createdAt.toISOString()}|${id}`).replace(/=+$/, '');
}
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [iso, id] = atob(cursor).split('|');
    const createdAt = new Date(iso ?? '');
    if (Number.isNaN(createdAt.getTime()) || !id || !UUID.test(id)) throw new Error('bad');
    return { createdAt, id };
  } catch {
    throw bad('Invalid cursor.');
  }
}

cashierActivityRoutes.get('/', authenticate, resolveTenantContext, async (c) => {
  const businessId = c.get('businessId');
  const q = new URL(c.req.url).searchParams;

  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(`limit must be 1-${MAX_LIMIT}.`);

  const category = q.get('category');
  if (category && !(CASHIER_CATEGORIES as readonly string[]).includes(category)) throw bad('Unknown category.');
  const branchFilter = q.get('branchId') ?? undefined;
  if (branchFilter && !UUID.test(branchFilter)) throw bad('Invalid branchId.');
  const actorFilter = q.get('actorUserId') ?? undefined;
  if (actorFilter && !UUID.test(actorFilter)) throw bad('Invalid actorUserId.');
  const cursor = q.get('cursor');

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    // F1: visibility is decided per branch from effective permissions, never from "any role at that branch".
    const scope = await resolveActivityScope(repos, c.get('userId'), businessId);
    if (!scope.all && scope.branchIds.length === 0) {
      throw new AppError('Missing required permission to view cashier activity.', 403, 'PERMISSION_DENIED');
    }
    const branchIds = scope.all ? null : scope.branchIds;
    // The branch the caller is acting for (X-Branch-Id) must itself be one they may read: a header for a branch where
    // they only hold a non-viewing role cannot be used to borrow visibility granted elsewhere.
    const actingBranch = c.get('branchId');
    if (branchIds && actingBranch && !branchIds.includes(actingBranch)) {
      throw new AppError('You do not have access to this branch.', 403, 'BRANCH_ACCESS_DENIED');
    }
    if (branchFilter && branchIds && !branchIds.includes(branchFilter)) {
      throw new AppError('You do not have access to this branch.', 403, 'BRANCH_ACCESS_DENIED');
    }

    const rows = await repos.auditLog.listCashierActivity({
      businessId,
      branchIds,
      branchId: branchFilter,
      actorUserId: actorFilter,
      selection: category ? filterFor(category as CashierCategory) : undefined,
      from: parseDate(q.get('from') ?? undefined, 'from'),
      to: parseDate(q.get('to') ?? undefined, 'to'),
      before: cursor ? decodeCursor(cursor) : undefined,
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    const branchNames = new Map<string, string>();
    const wanted = new Set(page.flatMap((r) => (typeof (r.metadata as { branchId?: unknown } | null)?.branchId === 'string' ? [(r.metadata as { branchId: string }).branchId] : [])));
    if (wanted.size > 0) {
      for (const b of await repos.branches.listByBusiness(businessId, { limit: 500 })) {
        if (wanted.has(b.id)) branchNames.set(b.id, b.name);
      }
    }

    const items = page.flatMap((r) => {
      const meta = (r.metadata ?? null) as Record<string, unknown> | null;
      const cat = categorize(r.action, meta);
      if (!cat) return [];
      const branchId = typeof meta?.branchId === 'string' ? meta.branchId : null;
      return [
        {
          // The audit row id doubles as the correlation id for support and cross-reference.
          correlationId: r.id,
          timestamp: r.createdAt,
          businessId: r.businessId,
          branchId,
          branchName: branchId ? (branchNames.get(branchId) ?? null) : null,
          actor: { id: r.actorUserId, name: r.actorFullName },
          action: r.action,
          categories: cat.categories,
          outcome: cat.outcome,
          errorCode: typeof meta?.errorCode === 'string' ? meta.errorCode : null,
          reference: safeReference(r.entityType, r.entityId),
        },
      ];
    });

    return ok(c, {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
