import { and, eq, desc } from 'drizzle-orm';
import type { Db } from '../db/client';
import { stripeSubscriptionTierObservations } from '../db/schema';

/**
 * Fail-closed history inspector for Split 07 award candidates.
 * A signed Stripe event proves what was OBSERVED, not when a price became
 * effective. Neither event.created nor item.current_period_start establishes
 * the start of a mid-cycle subscription upgrade/downgrade.
 */
export class HistoricalSubscriptionTierReader {
  constructor(private readonly db: Db) {}

  async inspect(input: {
    businessId: string; stripeCustomerId: string; stripeSubscriptionId: string;
    fulfilledAt: Date;
  }): Promise<{
    historicalTierVerified: false; issuanceAuthorized: false;
    reason: 'INVALID_INPUT' | 'NO_PROVIDER_HISTORY' | 'IDENTITY_MISMATCH' | 'EFFECTIVE_WINDOW_UNPROVEN';
    observations: number;
  }> {
    if (!input.businessId || !input.stripeCustomerId.startsWith('cus_') ||
        !input.stripeSubscriptionId.startsWith('sub_') ||
        !Number.isFinite(input.fulfilledAt.getTime()))
      return { historicalTierVerified:false, issuanceAuthorized:false, reason:'INVALID_INPUT', observations:0 };
    const rows = await this.db.select({
      customerId: stripeSubscriptionTierObservations.stripeCustomerId,
      subscriptionId: stripeSubscriptionTierObservations.stripeSubscriptionId,
      eventId: stripeSubscriptionTierObservations.stripeEventId,
    }).from(stripeSubscriptionTierObservations)
      .where(eq(stripeSubscriptionTierObservations.businessId, input.businessId))
      .orderBy(desc(stripeSubscriptionTierObservations.stripeEventCreatedAt))
      .limit(100);
    if (!rows.length)
      return {historicalTierVerified:false,issuanceAuthorized:false,reason:'NO_PROVIDER_HISTORY',observations:0};
    if (!rows.some(r=>r.customerId===input.stripeCustomerId && r.subscriptionId===input.stripeSubscriptionId))
      return {historicalTierVerified:false,issuanceAuthorized:false,reason:'IDENTITY_MISMATCH',observations:rows.length};
    // NEVER infer fulfillment-time price from receipt order or billing period.
    // A separate provider reconciliation + trusted effective-window authority
    // is necessary before a positive verification result can exist.
    return {historicalTierVerified:false,issuanceAuthorized:false,reason:'EFFECTIVE_WINDOW_UNPROVEN',observations:rows.length};
  }
}
