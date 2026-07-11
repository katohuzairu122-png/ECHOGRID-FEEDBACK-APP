import { Hono } from 'hono';
import type { PlatformAuditLogEntryDto } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories, type AuditLogEntryWithDetails } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables;
};

export const platformAuditLogRoutes = new Hono<Env>();

/** Read-only for every platform role -- support's whole purpose is
 * cross-tenant visibility for debugging (see db/schema/users.ts's
 * PLATFORM_ROLES comment), so this is not admin-gated like the directory's
 * status-change endpoint. */
platformAuditLogRoutes.use('*', authenticate, requirePlatformRole(['support', 'billing', 'admin']));

function toPlatformAuditLogEntryDto(entry: AuditLogEntryWithDetails): PlatformAuditLogEntryDto {
  return {
    id: entry.id,
    businessId: entry.businessId,
    businessName: entry.businessName,
    actorUserId: entry.actorUserId,
    actorEmail: entry.actorEmail,
    actorFullName: entry.actorFullName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata as PlatformAuditLogEntryDto['metadata'],
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Platform-wide audit log -- every business's entries, filterable. The
 * cross-tenant counterpart to GET /businesses/audit-log (business.routes.ts),
 * which stays scoped to the caller's own tenant. All filters optional and
 * ANDed; omitting all of them returns the full platform log.
 */
platformAuditLogRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  const businessId = url.searchParams.get('businessId') ?? undefined;
  const actorUserId = url.searchParams.get('actorUserId') ?? undefined;
  const entityType = url.searchParams.get('entityType') ?? undefined;
  const action = url.searchParams.get('action') ?? undefined;

  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const from = fromParam ? new Date(fromParam) : undefined;
  const to = toParam ? new Date(toParam) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw new AppError('Invalid from/to date -- use ISO 8601.', 400, 'INVALID_DATE_RANGE');
  }

  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const entries = await createRepositories(db).auditLog.listAllWithDetails(
      { businessId, actorUserId, entityType, action, from, to },
      { limit, offset },
    );
    return ok(c, entries.map(toPlatformAuditLogEntryDto));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
