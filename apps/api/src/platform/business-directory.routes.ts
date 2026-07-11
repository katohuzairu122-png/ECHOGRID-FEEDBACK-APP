import { Hono } from 'hono';
import {
  updateBusinessStatusSchema,
  impersonateSchema,
  type PlatformBusinessDto,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories, type Business, type BusinessStatus } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { ImpersonationService } from './impersonation.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables & AuditVariables;
};

export const platformBusinessRoutes = new Hono<Env>();

platformBusinessRoutes.use('*', authenticate);

const VALID_STATUSES: readonly BusinessStatus[] = ['active', 'suspended', 'archived'];

/** Shapes a raw Business row down to the platform contract (platform.ts) --
 * deliberately excludes audit/soft-delete bookkeeping columns (createdBy,
 * updatedBy, isDeleted, deletedAt, deletedBy) that aren't part of that
 * contract, so the actual response never silently drifts wider than what's
 * documented. */
function toPlatformBusinessDto(business: Business): PlatformBusinessDto {
  return {
    id: business.id,
    name: business.name,
    slug: business.slug,
    legalName: business.legalName,
    industry: business.industry,
    defaultLocale: business.defaultLocale,
    defaultCurrency: business.defaultCurrency,
    defaultTimezone: business.defaultTimezone,
    status: business.status as PlatformBusinessDto['status'],
    createdAt: business.createdAt.toISOString(),
  };
}

/**
 * Cross-tenant business directory -- the console's main list screen.
 * Read-only, open to every platform role: support needs it to locate an
 * account to debug, billing to look up a subscription, admin for everything
 * else (see db/schema/users.ts's PLATFORM_ROLES comment).
 */
platformBusinessRoutes.get('/', requirePlatformRole(['support', 'billing', 'admin']), async (c) => {
  const url = new URL(c.req.url);
  const search = url.searchParams.get('search')?.trim() || undefined;
  const statusParam = url.searchParams.get('status');
  if (statusParam && !VALID_STATUSES.includes(statusParam as BusinessStatus)) {
    throw new AppError(
      `Invalid status filter: ${statusParam}. Must be one of ${VALID_STATUSES.join(', ')}.`,
      400,
      'INVALID_STATUS_FILTER',
    );
  }
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const businesses = await createRepositories(db).businesses.list({
      search,
      status: (statusParam as BusinessStatus) || undefined,
      limit,
      offset,
    });
    return ok(c, businesses.map(toPlatformBusinessDto));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

platformBusinessRoutes.get('/:id', requirePlatformRole(['support', 'billing', 'admin']), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const business = await createRepositories(db).businesses.findById(c.req.param('id'));
    if (!business) {
      throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    }
    return ok(c, toPlatformBusinessDto(business));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Suspend/reactivate/archive -- admin-only. support/billing get read access
 * above, not the ability to take a paying customer's business offline (see
 * PLATFORM_ROLES comment). Sets auditMetadata.businessId explicitly since
 * there is no tenant context to fall back to here (see middleware/audit.ts)
 * -- without it, the affected business would never see this action in its
 * own GET /businesses/audit-log.
 */
platformBusinessRoutes.patch('/:id/status', requirePlatformRole(['admin']), async (c) => {
  const id = c.req.param('id');
  const body = await parseJsonBody(c.req.raw, updateBusinessStatusSchema);

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const business = await createRepositories(db).businesses.update(
      id,
      { status: body.status },
      c.get('userId'),
    );
    if (!business) {
      throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    }

    c.set('auditMetadata', {
      action: 'business.status_changed_by_platform',
      entityType: 'business',
      entityId: business.id,
      businessId: business.id,
      details: { status: body.status, reason: body.reason ?? null },
    });

    return ok(c, toPlatformBusinessDto(business));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * A business's team, hydrated with user/role display fields -- read-only,
 * open to every platform role (same reasoning as GET / above). Primary
 * purpose is letting the console's impersonation picker (Block 7) show
 * names instead of raw user IDs, but it's generally useful business-detail
 * context on its own.
 */
platformBusinessRoutes.get(
  '/:id/team',
  requirePlatformRole(['support', 'billing', 'admin']),
  async (c) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      const business = await repos.businesses.findById(c.req.param('id'));
      if (!business) {
        throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
      }
      const team = await repos.userBusinessRoles.listForBusinessWithDetails(business.id);
      return ok(c, team);
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

/**
 * Impersonation -- support/admin only, deliberately NOT billing (see
 * db/schema/users.ts's PLATFORM_ROLES comment for the reasoning).
 *
 * Mints a short-lived (30 min), non-renewable access token for the target
 * user -- no refresh token, so the session cannot be silently extended; the
 * admin re-initiates through this same endpoint when it expires, which
 * re-validates the grant and re-logs the action every time. `reason` is
 * required (impersonateSchema), unlike PATCH /:id/status's optional one --
 * assuming another user's identity is a materially more sensitive action
 * than flipping a status flag.
 */
platformBusinessRoutes.post(
  '/:id/impersonate',
  requirePlatformRole(['support', 'admin']),
  async (c) => {
    const businessId = c.req.param('id');
    const body = await parseJsonBody(c.req.raw, impersonateSchema);

    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      const service = new ImpersonationService(repos, c.env.JWT_ACCESS_SECRET);
      const result = await service.impersonate(
        { targetUserId: body.userId, businessId },
        c.get('userId'),
      );

      c.set('auditMetadata', {
        action: 'user.impersonation_started',
        entityType: 'user',
        entityId: result.targetUser.id,
        businessId,
        details: { targetUserEmail: result.targetUser.email, reason: body.reason },
      });

      return ok(
        c,
        {
          accessToken: result.accessToken,
          expiresAt: result.expiresAt.toISOString(),
          targetUser: result.targetUser,
        },
        201,
      );
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
