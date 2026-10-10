import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { createDb } from '../db/client';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { PartnerEnrollmentService } from './partner-enrollment.service';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };
export const partnerConsentRoutes = new Hono<Env>();

/** Version-pinned program statement. Changing this requires policy review. */
export const PARTNER_TERMS_V1 = 'Echo Grid Partner Program PC-ECON/1: Partner Credits are noncash, nontransferable platform service entitlements; one per qualifying verified fulfilled orphan settlement, up to ten per receiving business per UTC month, with a fourteen-day provisional hold. They are not retail reimbursement, cash, loyalty points, Community Points, or Stripe money. Billing application requires separate Split 08 authorization.';
const acceptanceSchema = z.object({
  policyVersion: z.literal('PC-ECON/1'),
  termsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  accepted: z.literal(true),
}).strict();
async function canonicalDigest(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PARTNER_TERMS_V1));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

partnerConsentRoutes.use('*', authenticate, resolveTenantContext, requireBusinessWideAccess);
partnerConsentRoutes.get('/terms', requirePermission('billing:manage'), async c =>
  ok(c, { policyVersion: 'PC-ECON/1', terms: PARTNER_TERMS_V1, termsDigest: await canonicalDigest() }),
);
partnerConsentRoutes.post('/accept', requirePermission('billing:manage'), async c => {
  // Impersonation is explicitly not consent, even when impersonated subject has billing permissions.
  if (c.get('impersonatedBy')) throw new AppError('Impersonation cannot accept Partner terms.', 403, 'PARTNER_CONSENT_IMPERSONATION_DENIED');
  const body = await parseJsonBody(c.req.raw, acceptanceSchema);
  if (body.termsDigest !== await canonicalDigest()) {
    throw new AppError('Partner Program terms have changed.', 409, 'PARTNER_TERMS_MISMATCH');
  }
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await new PartnerEnrollmentService(db).recordAcceptance({
      businessId: c.get('businessId'),
      authenticatedUserId: c.get('userId'),
      policyVersion: body.policyVersion,
      termsDigest: body.termsDigest,
    });
    return ok(c, result);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
