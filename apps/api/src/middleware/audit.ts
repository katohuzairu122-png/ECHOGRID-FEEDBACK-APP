import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';

export type AuditVariables = {
  auditMetadata?: {
    action?: string;
    entityType?: string;
    entityId?: string;
    details?: unknown;
    // Platform Admin Console (Block 3): platform routes never run
    // resolveTenantContext, so there is no c.get('businessId') to fall back
    // to -- a platform action (e.g. suspending a business) has no "acting
    // tenant," only an affected one. Setting this lets that affected
    // business's OWN audit log (GET /businesses/audit-log) surface the
    // platform action taken against it, instead of the entry being
    // orphaned with businessId=null and invisible to the business itself.
    businessId?: string;
  };
};

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Automatically records an audit_log entry for every mutating (non-GET)
 * request under /api/v1 that completes successfully (2xx) -- no changes
 * needed in a route handler for baseline coverage. A handler can enrich the
 * entry with what specifically changed by calling
 * `c.set('auditMetadata', {...})` before returning; otherwise a generic
 * "<METHOD> <path>" entry is recorded.
 *
 * Mounted globally in index.ts, so it runs regardless of whether a given
 * route used `authenticate`/`resolveTenantContext` -- it silently no-ops if
 * there's no authenticated actor (e.g. /auth/signup, /auth/login: sensible,
 * since there's no one to attribute the entry to yet; the `users` table's
 * own createdAt/audit columns record account creation instead).
 *
 * Failed requests (4xx/5xx) are not audited -- the error itself is what
 * matters there, not a redundant log row, and it's already visible via
 * Workers Logs. A failure while WRITING the audit entry is caught and
 * logged rather than thrown, so it can never turn an already-successful
 * response into a 500.
 */
export const auditTrail = createMiddleware<{
  Bindings: Bindings;
  Variables: Partial<AuthVariables> & Partial<TenantVariables> & AuditVariables;
}>(async (c, next) => {
  await next();

  if (!MUTATING_METHODS.has(c.req.method)) return;
  if (c.res.status < 200 || c.res.status >= 300) return;

  const actorUserId = c.get('userId');
  if (!actorUserId) return;

  try {
    const meta = c.get('auditMetadata');
    // Platform Admin Console Block 4: unconditional, not opt-in per route --
    // if a request happened under impersonation, every entry it produces
    // says so, regardless of whether the handler bothered to set custom
    // auditMetadata. This is the accountability guarantee the whole feature
    // depends on, so it can't be something an individual route forgets.
    const impersonatedBy = c.get('impersonatedBy');
    const details = impersonatedBy
      ? { ...(meta?.details && typeof meta.details === 'object' ? meta.details : {}), impersonatedBy }
      : (meta?.details ?? null);

    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      await repos.auditLog.record({
        businessId: meta?.businessId ?? c.get('businessId') ?? null,
        actorUserId,
        action: meta?.action ?? `${c.req.method} ${new URL(c.req.url).pathname}`,
        entityType: meta?.entityType ?? 'unknown',
        entityId: meta?.entityId ?? null,
        metadata: details,
        ipAddress: c.req.header('cf-connecting-ip') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  } catch (err) {
    console.error('Failed to write audit log entry:', err);
  }
});
