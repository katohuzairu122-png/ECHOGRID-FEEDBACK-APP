import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { COMMUNITY_HUB_PERMISSIONS, type BusinessCommunityStatus } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { requireAnyPermission } from '../middleware/require-permission';
import { ok } from '../lib/response';
import { createDb } from '../db/client';
import { resolveMinimumGroupSize, summarizeParticipation } from './community-participation-aggregate';
import { isBusinessDistributionEnabled, isBusinessPublishingEnabled, isNetworkFeedEnabled } from '../network/network-flag';
import { COMMUNITY_MEMBERSHIP_CONTROL_KEYS } from './community-membership-controls';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };

/**
 * BCOMM-01: the business Community hub. READ-ONLY and data-free: it reports whether each Community capability is currently open, so the hub can
 * say the truth about rollout. It reads only the existing server runtime controls, writes nothing, touches no customer, membership, consent,
 * points or ledger data, and carries no tenant data at all (the answer is the same for every business). Business-wide managers only: a
 * branch-scoped or counter-staff identity, a user from another business (tenant resolution) and an unauthenticated caller are all refused.
 */
export const communityBusinessRoutes = new Hono<Env>();

communityBusinessRoutes.get(
  '/status',
  authenticate,
  resolveTenantContext,
  requireBusinessWideAccess,
  requireAnyPermission(COMMUNITY_HUB_PERMISSIONS),
  (c) => {
    const env = c.env as unknown as Record<string, unknown>;
    // "Open" only for the exact string "true", the same rule the enrollment gates themselves apply. Reading this never enrolls anyone.
    const enrollmentOpen = [
      COMMUNITY_MEMBERSHIP_CONTROL_KEYS.join,
      COMMUNITY_MEMBERSHIP_CONTROL_KEYS.rejoin,
      COMMUNITY_MEMBERSHIP_CONTROL_KEYS.restore,
    ].some((key) => env[key] === 'true');
    const status: BusinessCommunityStatus = {
      enrollment: enrollmentOpen ? 'open' : 'closed',
      feed: isNetworkFeedEnabled(c.env) ? 'open' : 'closed',
      publishing: isBusinessPublishingEnabled(c.env) ? 'open' : 'closed',
      distribution: isBusinessDistributionEnabled(c.env) && isNetworkFeedEnabled(c.env) ? 'open' : 'closed',
    };
    c.header('Cache-Control', 'no-store');
    return ok(c, status);
  },
);

/**
 * BCOMM-02: privacy-protected participation TOTALS for the caller's own business: its active loyalty customers and how many of them currently
 * hold an active Community membership. READ-ONLY (one aggregate SELECT), scoped to the resolved business, same business-wide permission gate as
 * the status route. Only counts leave the database: no customer id, name, contact, points or consent record is selected, and small groups are
 * suppressed by the server (see community-participation-aggregate.ts). Nothing here enrolls anyone or changes any control.
 */
communityBusinessRoutes.get(
  '/participation',
  authenticate,
  resolveTenantContext,
  requireBusinessWideAccess,
  requireAnyPermission(COMMUNITY_HUB_PERMISSIONS),
  async (c) => {
    const businessId = c.get('businessId');
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const result = await db.execute(sql`
        SELECT count(*)::int AS eligible,
               (count(*) FILTER (WHERE cm.status = 'active'))::int AS participants
        FROM loyalty_accounts la
        LEFT JOIN community_memberships cm ON cm.customer_id = la.customer_id
        WHERE la.business_id = ${businessId} AND la.status = 'active' AND la.is_deleted = false`);
      const row = (result.rows?.[0] ?? { eligible: 0, participants: 0 }) as { eligible: number; participants: number };
      c.header('Cache-Control', 'no-store');
      return ok(c, summarizeParticipation({ eligible: Number(row.eligible), participants: Number(row.participants) },
        resolveMinimumGroupSize(c.env.COMMUNITY_AGGREGATE_MIN_GROUP_SIZE)));
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
