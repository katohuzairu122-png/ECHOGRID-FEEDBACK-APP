import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { businesses, partnerCreditAwardDecisions, partnerCreditPolicies, partnerProgramEnrollments, orphanSettlements } from '../db/schema';
import { partnerEarningMonthUtc, provisionalAwardEligibility } from './partner-credit-award-eligibility';

/**
 * Block 2 preflight under a business-row lock. Zero economic writes.
 * The future award writer MUST repeat all settlement/claim/event/reversal
 * verification inside its atomic mutation transaction and share lock ordering
 * with the Split 06 reversal path. This plan is not issuance authorization.
 */
export class PartnerProvisionalAwardPlanner {
  constructor(private readonly db: Database) {}
  async inspect(input: { businessId: string; settlementRef: string }) {
    return this.db.transaction(async tx => {
      const [business] = await tx.select({ id: businesses.id }).from(businesses)
        .where(and(eq(businesses.id, input.businessId), eq(businesses.status, 'active')))
        .for('update');
      if (!business) return { state: 'ineligible' as const, reason: 'business_inactive' as const };
      const [settlement] = await tx.select().from(orphanSettlements)
        .where(and(eq(orphanSettlements.id, input.settlementRef),
          eq(orphanSettlements.receivingBusinessId, input.businessId))).for('update');
      if (!settlement || settlement.status !== 'fulfilled' || !settlement.fulfilledAt)
        return { state: 'ineligible' as const, reason: 'not_fulfilled' as const };
      const existing = await tx.query.partnerCreditAwardDecisions.findFirst({
        where: eq(partnerCreditAwardDecisions.settlementRef, input.settlementRef),
      });
      if (existing) return { state: 'existing' as const, decisionId: existing.id };
      const enrollment = await tx.query.partnerProgramEnrollments.findFirst({
        where: and(eq(partnerProgramEnrollments.businessId, input.businessId),
          eq(partnerProgramEnrollments.status, 'active')),
      });
      if (!enrollment) return { state: 'ineligible' as const, reason: 'not_enrolled' as const };
      const policy = await tx.query.partnerCreditPolicies.findFirst({
        where: and(eq(partnerCreditPolicies.version, enrollment.policyVersion),
          eq(partnerCreditPolicies.state, 'active')),
      });
      if (!policy || !policy.effectiveAt || policy.awardUnits !== 1 || policy.monthlyCap !== 10 ||
          policy.vestDays !== 14 || policy.expiresAfterMonths !== 12)
        return { state: 'ineligible' as const, reason: 'policy_invalid' as const };
      const month = partnerEarningMonthUtc(settlement.fulfilledAt);
      const [total] = await tx.select({ units: sql<number>`COALESCE(SUM(${partnerCreditAwardDecisions.awardUnits}), 0)::integer` })
        .from(partnerCreditAwardDecisions)
        .where(and(eq(partnerCreditAwardDecisions.businessId, input.businessId),
          eq(partnerCreditAwardDecisions.earningMonthUtc, month),
          sql`${partnerCreditAwardDecisions.awardUnits} > 0`));
      const eligibility = provisionalAwardEligibility({
        fulfilledAt: settlement.fulfilledAt,
        enrolledEffectiveAt: enrollment.effectiveAt,
        policyEffectiveAt: policy.effectiveAt,
        awardedUnitsInUtcMonth: total?.units ?? 0,
      });
      return { state: eligibility, month, units: eligibility === 'eligible' ? 1 : 0,
        // Preliminary planning only, not a vesting timestamp guarantee.
        settlementRef: settlement.id };
    });
  }
}
