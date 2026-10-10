import { and, eq, sql } from 'drizzle-orm';
import type { OrphanSettlementCompletionEvidence } from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import {
  businesses, orphanRewardClaims, orphanSettlementEvents, orphanSettlements,
  partnerProgramEnrollments, partnerCreditPolicies, partnerCreditAccounts,
  partnerCreditAwardDecisions, partnerCreditLots, partnerCreditLedger,
} from '../db/schema';
import { partnerEarningMonthUtc, provisionalAwardEligibility } from './partner-credit-award-eligibility';

type AwardResult =
  | { state: 'provisional'; decisionId: string; units: 1; replay: boolean }
  | { state: 'cap_exceeded' | 'ineligible'; decisionId: string; units: 0; replay: boolean };

/**
 * Block 2 internal transaction implementation. NO public route or queue calls
 * this class. Migration 0041 still rejects decision, lot, ledger and account
 * writes: this code cannot mint credits until a separately audited release gate
 * replaces those database-level barriers. No Stripe or invoice access.
 */
export class PartnerProvisionalAwardService {
  constructor(private readonly db: Database) {}

  async decide(evidence: OrphanSettlementCompletionEvidence): Promise<AwardResult> {
    if (evidence.evidenceVersion !== 'v1') throw new Error('PARTNER_AWARD_EVIDENCE_VERSION_INVALID');
    return this.db.transaction(async tx => {
      // Split 06 reversal locks this row first; hold it until this decision commits.
      const [settlement] = await tx.select().from(orphanSettlements)
        .where(eq(orphanSettlements.id, evidence.settlementRef)).for('update');
      if (!settlement || settlement.status !== 'fulfilled' || !settlement.fulfilledAt ||
          !settlement.completionAuthorizationId || !settlement.completionAuthorizedAt ||
          !settlement.acceptedByUserId || !settlement.fulfillmentPolicyVersion ||
          !settlement.fulfillmentSnapshot ||
          settlement.claimId !== evidence.claimId ||
          settlement.customerId !== evidence.customerId ||
          settlement.receivingBusinessId !== evidence.receivingBusinessId ||
          settlement.receivingBranchId !== evidence.receivingBranchId ||
          settlement.fulfilledAt.toISOString() !== evidence.fulfilledAt ||
          settlement.fulfillmentPolicyVersion !== evidence.fulfillmentPolicyVersion ||
          settlement.fulfillmentReference !== evidence.fulfillmentReference)
        throw new Error('PARTNER_AWARD_SETTLEMENT_EVIDENCE_INVALID');

      // Business-row lock prevents concurrent awards across all its branches
      // from evaluating the same cap before either transaction commits.
      const [business] = await tx.select({ id: businesses.id }).from(businesses)
        .where(and(eq(businesses.id, settlement.receivingBusinessId),
          eq(businesses.status, 'active'))).for('update');
      if (!business) throw new Error('PARTNER_AWARD_RECEIVER_INACTIVE');

      const [claim] = await tx.select().from(orphanRewardClaims)
        .where(eq(orphanRewardClaims.id, settlement.claimId)).for('update');
      if (!claim || claim.status !== 'settled' || !claim.settledAt ||
          claim.customerId !== settlement.customerId || claim.reversedAt ||
          claim.originBusinessId !== evidence.originBusinessId ||
          claim.originBusinessId === settlement.receivingBusinessId)
        throw new Error('PARTNER_AWARD_CLAIM_INVALID');

      const [fulfilledEvent] = await tx.select().from(orphanSettlementEvents)
        .where(eq(orphanSettlementEvents.idempotencyKey, `settlement-fulfilled:${settlement.id}`))
        .limit(1);
      if (!fulfilledEvent || fulfilledEvent.eventType !== 'settlement_fulfilled' ||
          fulfilledEvent.settlementId !== settlement.id ||
          fulfilledEvent.claimId !== claim.id ||
          fulfilledEvent.customerId !== claim.customerId ||
          fulfilledEvent.originBusinessId !== claim.originBusinessId ||
          fulfilledEvent.receivingBusinessId !== settlement.receivingBusinessId ||
          fulfilledEvent.receivingBranchId !== settlement.receivingBranchId)
        throw new Error('PARTNER_AWARD_FULFILLMENT_HISTORY_INVALID');

      const [reversed] = await tx.select({ id: orphanSettlementEvents.id })
        .from(orphanSettlementEvents)
        .where(and(eq(orphanSettlementEvents.settlementId, settlement.id),
          eq(orphanSettlementEvents.eventType, 'settlement_reversed'))).limit(1);
      if (reversed) throw new Error('PARTNER_AWARD_REVERSED_SETTLEMENT');

      const key = `partner-award:v1:${settlement.id}`;
      const [existing] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.settlementRef, settlement.id)).limit(1);
      if (existing) {
        if (existing.businessId !== business.id || existing.idempotencyKey !== key ||
            existing.fulfilledAt.toISOString() !== settlement.fulfilledAt.toISOString() ||
            existing.earningMonthUtc !== partnerEarningMonthUtc(settlement.fulfilledAt))
          throw new Error('PARTNER_AWARD_CONFLICTING_REPLAY');
        if (existing.state !== 'provisional' && existing.state !== 'cap_exceeded' &&
            existing.state !== 'ineligible')
          throw new Error('PARTNER_AWARD_TERMINAL_STATE_REQUIRES_LIFECYCLE');
        return {
          state: existing.state,
          decisionId: existing.id,
          units: existing.awardUnits === 1 && existing.state === 'provisional' ? 1 : 0,
          replay: true,
        } as AwardResult;
      }

      const [enrollment] = await tx.select().from(partnerProgramEnrollments)
        .where(and(eq(partnerProgramEnrollments.businessId, business.id),
          eq(partnerProgramEnrollments.status, 'active'))).for('update');
      // No post-facto enrollment or hidden backfill. Ineligible settlements
      // without an enrollment are not inserted into the economic ledger.
      if (!enrollment || enrollment.effectiveAt > settlement.fulfilledAt)
        throw new Error('PARTNER_AWARD_NO_ELIGIBLE_ENROLLMENT');

      const [policy] = await tx.select().from(partnerCreditPolicies)
        .where(and(eq(partnerCreditPolicies.version, enrollment.policyVersion),
          eq(partnerCreditPolicies.state, 'active'))).for('share');
      if (!policy || !policy.effectiveAt || policy.effectiveAt > settlement.fulfilledAt ||
          policy.awardUnits !== 1 || policy.monthlyCap !== 10 ||
          policy.vestDays !== 14 || policy.expiresAfterMonths !== 12)
        throw new Error('PARTNER_AWARD_POLICY_INVALID');

      const earningMonthUtc = partnerEarningMonthUtc(settlement.fulfilledAt);
      const [count] = await tx.select({
        units: sql<number>`COALESCE(SUM(${partnerCreditAwardDecisions.awardUnits}),0)::integer`,
      }).from(partnerCreditAwardDecisions)
        .where(and(eq(partnerCreditAwardDecisions.businessId, business.id),
          eq(partnerCreditAwardDecisions.earningMonthUtc, earningMonthUtc),
          sql`${partnerCreditAwardDecisions.awardUnits} > 0`));
      const eligible = provisionalAwardEligibility({
        fulfilledAt: settlement.fulfilledAt,
        enrolledEffectiveAt: enrollment.effectiveAt,
        policyEffectiveAt: policy.effectiveAt,
        awardedUnitsInUtcMonth: count?.units ?? 0,
      });
      if (eligible === 'pre_enrollment' || eligible === 'policy_not_effective')
        throw new Error('PARTNER_AWARD_HISTORICAL_SETTLEMENT_DENIED');
      const capped = eligible === 'cap_exceeded';
      const now = new Date();
      const holdEnd = new Date(settlement.fulfilledAt.getTime() + 14 * 86400_000);
      const vestAt = holdEnd > now ? holdEnd : now;
      const [decision] = await tx.insert(partnerCreditAwardDecisions).values({
        settlementRef: settlement.id, businessId: business.id, policyId: policy.id,
        state: capped ? 'cap_exceeded' : 'provisional', awardUnits: capped ? 0 : 1,
        earningMonthUtc, fulfilledAt: settlement.fulfilledAt,
        vestAt: capped ? null : vestAt, idempotencyKey: key,
      }).returning();
      if (!decision) throw new Error('PARTNER_AWARD_DECISION_INSERT_FAILED');
      if (capped) return { state: 'cap_exceeded', decisionId: decision.id, units: 0, replay: false };

      // All changes below must commit together; no available balance is added.
      const [account] = await tx.insert(partnerCreditAccounts).values({
        businessId: business.id,
      }).onConflictDoUpdate({
        target: partnerCreditAccounts.businessId,
        set: { updatedAt: now },
      }).returning();
      if (!account) throw new Error('PARTNER_AWARD_ACCOUNT_MISSING');
      await tx.insert(partnerCreditLots).values({
        decisionId: decision.id, accountId: account.id, units: 1, availableUnits: 0,
        status: 'provisional', vestAt,
      });
      await tx.insert(partnerCreditLedger).values({
        accountId: account.id, decisionId: decision.id, entryType: 'provisional',
        units: 1, idempotencyKey: `partner-provisional:v1:${settlement.id}`,
        metadata: {
          settlementRef: settlement.id, fulfilledEventId: fulfilledEvent.id,
          policyVersion: policy.version, earningMonthUtc,
          economicUnits: 'noncash_partner_credit',
        },
      });
      await tx.update(partnerCreditAccounts).set({
        provisional: sql`${partnerCreditAccounts.provisional} + 1`,
        updatedAt: now,
      }).where(eq(partnerCreditAccounts.id, account.id));
      return { state: 'provisional', decisionId: decision.id, units: 1, replay: false };
    });
  }
}
