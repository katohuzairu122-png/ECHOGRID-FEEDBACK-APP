import { Hono } from 'hono';
import {
  updateBusinessAppearanceSchema,
  BUSINESS_LOGO_KEYS,
  BUSINESS_BRAND_COLOR_KEYS,
  type BusinessAppearanceDto,
  type BusinessLogoKey,
  type BusinessBrandColorKey,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };

const logos = new Set<string>(BUSINESS_LOGO_KEYS);
const colours = new Set<string>(BUSINESS_BRAND_COLOR_KEYS);

export function toBusinessAppearanceDto(
  businessId: string,
  businessName: string,
  row: { logoKey: string | null; brandColorKey: string | null } | undefined,
): BusinessAppearanceDto {
  return {
    businessId,
    businessName,
    logoKey: row?.logoKey && logos.has(row.logoKey) ? (row.logoKey as BusinessLogoKey) : null,
    brandColorKey: row?.brandColorKey && colours.has(row.brandColorKey) ? (row.brandColorKey as BusinessBrandColorKey) : null,
  };
}

/**
 * PROF-01: how the caller's business appears inside the platform (logo preset + brand colour). Any signed-in member of the
 * business may read it (the cashier and dashboard screens show it); changing it needs business-wide access and
 * `business:manage_settings`, like the other business settings. The business id comes from the verified tenant context.
 * No file is stored: the keys are built-in presets.
 */
export const businessAppearanceRoutes = new Hono<Env>();

businessAppearanceRoutes.get('/', authenticate, resolveTenantContext, async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const business = await repos.businesses.findById(c.get('businessId'));
    if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    return ok(c, toBusinessAppearanceDto(business.id, business.name, await repos.businessAppearance.findByBusiness(business.id)));
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

businessAppearanceRoutes.put(
  '/',
  authenticate,
  resolveTenantContext,
  requireBusinessWideAccess,
  requirePermission('business:manage_settings'),
  async (c) => {
    const input = await parseJsonBody(c.req.raw, updateBusinessAppearanceSchema);
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      const business = await repos.businesses.findById(c.get('businessId'));
      if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
      const row = await repos.businessAppearance.upsert(business.id, input, c.get('userId'));
      c.set('auditMetadata', {
        action: 'business.appearance_updated',
        entityType: 'business',
        entityId: business.id,
        details: { fields: Object.keys(input) },
      });
      return ok(c, toBusinessAppearanceDto(business.id, business.name, row));
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
