import { Hono } from 'hono';
import { createBusinessSchema, updateBusinessSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { rateLimit } from '../middleware/rate-limit';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { BusinessService } from './business.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

export const businessRoutes = new Hono<Env>();

// Request/response shapes now live in @echo-grid-feedback/shared-types
// (createBusinessSchema originated in Branch Mgmt Block 1 for slugSchema
// alone; fully migrated in Block 4 once apps/web needed the same contract
// for its onboarding form) -- removed the duplicate that used to be inline
// here.

/**
 * Lists the businesses the authenticated user belongs to (deduped across
 * any per-branch grants) -- powers the dashboard's business switcher
 * (Branch Mgmt Block 4). Discovery, not tenant action, so only
 * `authenticate` is required, not `resolveTenantContext`.
 */
businessRoutes.get('/', authenticate, async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BusinessService(db);
    const businesses = await service.listForUser(c.get('userId'));
    return ok(c, businesses);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Fully anonymous, name-only lookup -- the Loyalty module's customer-facing
 * pages (app/loyalty/dashboard/*) need to display which business a loyalty
 * account belongs to, but a customer has no staff session to call the
 * authenticated GET /businesses with. PUBLIC_RATE_LIMITER, same as the
 * qr.routes.ts anonymous surface. Mounted before the id-less routes below
 * so it doesn't shadow them -- distinct concrete paths, no actual
 * conflict, but keeping public/anonymous routes visually grouped together
 * at the top of the file matches qr.routes.ts's own convention.
 */
businessRoutes.get('/:id/public', rateLimit('PUBLIC_RATE_LIMITER'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const business = await createRepositories(db).businesses.findById(c.req.param('id'));
    if (!business) {
      throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    }
    return ok(c, {
      id: business.id,
      name: business.name,
      defaultLocale: business.defaultLocale,
      defaultCurrency: business.defaultCurrency,
      defaultTimezone: business.defaultTimezone,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Any authenticated user may create a business -- this is the bootstrapping
 * act itself, not an action taken within an existing tenant, so it only
 * needs `authenticate`, not `resolveTenantContext`/`requirePermission`. The
 * creator is granted Owner automatically (see BusinessService). Sets
 * businessId + auditMetadata on context so the global auditTrail middleware
 * (index.ts) records a precise "business.created" entry instead of its
 * generic "POST /businesses" fallback.
 */
businessRoutes.post('/', authenticate, async (c) => {
  const body = await parseJsonBody(c.req.raw, createBusinessSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new BusinessService(db);
    const result = await service.createBusiness(body, c.get('userId'));

    c.set('businessId', result.businessId);
    c.set('auditMetadata', {
      action: 'business.created',
      entityType: 'business',
      entityId: result.businessId,
      details: { name: body.name, slug: body.slug },
    });

    return ok(c, result, 201);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Demonstrates the full middleware chain (authenticate -> resolveTenantContext)
 * end to end: returns the caller's effective permissions for the business
 * named in X-Business-Id, e.g. for a frontend to ask "what can I do here."
 */
businessRoutes.get('/me', authenticate, resolveTenantContext, async (c) => {
  return ok(c, {
    businessId: c.get('businessId'),
    branchId: c.get('branchId') ?? null,
    permissions: Array.from(c.get('permissions')),
  });
});

/**
 * Updates the business named in X-Business-Id (i18n & Multi-Currency
 * Block 1) -- name and/or defaultLocale/defaultCurrency/defaultTimezone.
 * Scoped to /me rather than /:id, matching GET /me's precedent: there is
 * no legitimate case for an authenticated caller to patch a *different*
 * business than the one their tenant context already resolved to, so an
 * id-in-path would only add a redundant match-check for zero benefit.
 */
businessRoutes.patch(
  '/me',
  authenticate,
  resolveTenantContext,
  requirePermission('business:manage_settings'),
  async (c) => {
    const body = await parseJsonBody(c.req.raw, updateBusinessSchema);
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const service = new BusinessService(db);
      const business = await service.updateBusiness(c.get('businessId'), body, c.get('userId'));

      c.set('auditMetadata', {
        action: 'business.updated',
        entityType: 'business',
        entityId: business.id,
        details: { fields: Object.keys(body) },
      });

      return ok(c, business);
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

/** Read-only view of this business's audit trail, gated behind a real
 * permission (not just membership) -- demonstrates requirePermission, and
 * makes Block 8's audit capture actually inspectable. */
businessRoutes.get(
  '/audit-log',
  authenticate,
  resolveTenantContext,
  requirePermission('audit:view'),
  async (c) => {
    const url = new URL(c.req.url);
    const limit = Number(url.searchParams.get('limit')) || undefined;
    const offset = Number(url.searchParams.get('offset')) || undefined;

    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      const entries = await repos.auditLog.listForBusiness(c.get('businessId'), {
        limit,
        offset,
      });
      return ok(c, entries);
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
