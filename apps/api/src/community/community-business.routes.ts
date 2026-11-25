import { Hono } from 'hono';
import { COMMUNITY_HUB_PERMISSIONS, type BusinessCommunityStatus } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { requireAnyPermission } from '../middleware/require-permission';
import { ok } from '../lib/response';
import { isNetworkFeedEnabled } from '../network/network-flag';
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
      publishing: 'closed',
    };
    c.header('Cache-Control', 'no-store');
    return ok(c, status);
  },
);
