import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { communityPilotEligibilityEvents, customers } from '../db/schema';
import { createRepositories } from '../repositories';
import { AppError } from '../lib/errors';

/**
 * Community pilot eligibility. One of several independent conditions for a membership activation:
 *   global/operation control AND pilot eligibility (when pilot mode is required) AND current-policy consent AND valid customer state.
 * It is deliberately separate from the Feed flag (NETWORK_FEED_ENABLED) and from consent validation.
 *
 * Pilot mode is a server binding, never a client field:
 *   COMMUNITY_MEMBERSHIP_PILOT_REQUIRED  absent or exactly "false" -> pilot mode off (eligibility not consulted)
 *                                         exactly "true"            -> eligibility required
 *                                         ANY other value           -> eligibility required (fails closed to the stricter state)
 */
export const COMMUNITY_PILOT_CONTROL_KEY = 'COMMUNITY_MEMBERSHIP_PILOT_REQUIRED';
export type CommunityPilotControlConfig = Partial<Record<typeof COMMUNITY_PILOT_CONTROL_KEY, unknown>>;
export type CommunityPilotRequirement = 'not_required' | 'required';

export function communityPilotRequirement(config: CommunityPilotControlConfig = {}): CommunityPilotRequirement {
  const value = config[COMMUNITY_PILOT_CONTROL_KEY];
  return value === undefined || value === 'false' ? 'not_required' : 'required';
}

const lockKey = (customerId: string) => sql`hashtextextended(${'community-pilot:' + customerId}, 0)`;

/** True when the customer's latest pilot event is a grant. Takes a SHARED per-customer lock until the surrounding transaction ends, so a
 * concurrent revoke waits for an in-flight activation instead of racing it, and a revoke that has committed is always seen. */
export async function isCommunityPilotEligible(tx: Db, customerId: string): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${lockKey(customerId)})`);
  const [latest] = await tx
    .select({ action: communityPilotEligibilityEvents.action })
    .from(communityPilotEligibilityEvents)
    .where(eq(communityPilotEligibilityEvents.customerId, customerId))
    .orderBy(desc(communityPilotEligibilityEvents.seq))
    .limit(1);
  return latest?.action === 'grant';
}

export async function communityPilotAllows(tx: Db, customerId: string, requirement: CommunityPilotRequirement): Promise<boolean> {
  return requirement === 'not_required' ? true : isCommunityPilotEligible(tx, customerId);
}

export async function assertCommunityPilotEligible(tx: Db, customerId: string, requirement: CommunityPilotRequirement): Promise<void> {
  if (!(await communityPilotAllows(tx, customerId, requirement))) {
    throw new AppError('Community is not yet available for this account.', 403, 'COMMUNITY_PILOT_NOT_ELIGIBLE');
  }
}

export type CommunityPilotAuditContext = { actorUserId: string; ipAddress: string | null; userAgent: string | null };
export type CommunityPilotStatus = { customerId: string; eligible: boolean; latest: { action: 'grant' | 'revoke'; reason: string; at: string } | null };

/** Staff-only eligibility changes. Every change appends one event and one audit_log row in the same transaction. Idempotent: granting an
 * already-eligible customer (or revoking an ineligible one) appends nothing. */
export class CommunityPilotEligibilityService {
  constructor(private readonly db: Db) {}

  async status(customerId: string): Promise<CommunityPilotStatus> {
    const [latest] = await this.db
      .select()
      .from(communityPilotEligibilityEvents)
      .where(eq(communityPilotEligibilityEvents.customerId, customerId))
      .orderBy(desc(communityPilotEligibilityEvents.seq))
      .limit(1);
    return {
      customerId,
      eligible: latest?.action === 'grant',
      latest: latest ? { action: latest.action, reason: latest.reason, at: latest.createdAt.toISOString() } : null,
    };
  }

  grant(customerId: string, reason: string, audit: CommunityPilotAuditContext) { return this.change('grant', customerId, reason, audit); }
  revoke(customerId: string, reason: string, audit: CommunityPilotAuditContext) { return this.change('revoke', customerId, reason, audit); }

  private async change(action: 'grant' | 'revoke', customerId: string, reason: string, audit: CommunityPilotAuditContext) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(customerId)})`);
      const customer = await createRepositories(tx).customers.findById(customerId);
      if (!customer) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
      const [latest] = await tx
        .select({ action: communityPilotEligibilityEvents.action })
        .from(communityPilotEligibilityEvents)
        .where(eq(communityPilotEligibilityEvents.customerId, customerId))
        .orderBy(desc(communityPilotEligibilityEvents.seq))
        .limit(1);
      const eligible = latest?.action === 'grant';
      const changed = action === 'grant' ? !eligible : eligible;
      if (changed) {
        await tx.insert(communityPilotEligibilityEvents).values({ customerId, action, actorUserId: audit.actorUserId, reason });
        await createRepositories(tx).auditLog.record({
          businessId: null, actorUserId: audit.actorUserId, action: `community.pilot_${action}`, entityType: 'customer', entityId: customerId,
          metadata: { reason }, ipAddress: audit.ipAddress, userAgent: audit.userAgent,
        });
      }
      return { customerId, eligible: action === 'grant', changed };
    });
  }
}
