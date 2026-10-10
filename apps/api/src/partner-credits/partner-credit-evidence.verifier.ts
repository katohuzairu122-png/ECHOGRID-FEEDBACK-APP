import type { OrphanSettlementCompletionEvidence } from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import { createRepositories } from '../repositories';

/** Block 2: fail-closed, read-only authoritative evidence revalidation.
 * No reward/point/credit mutation, enrollment or billing capability exists here.
 * A prospective award writer MUST revalidate again under the same transaction
 * as its eventual award and serialize against Split 06 reversal.
 */
export type VerifiedPartnerFulfillment = {
  settlementRef: string;
  receivingBusinessId: string;
  fulfilledAt: Date;
  claimId: string;
  originBusinessId: string;
  fulfilledEventId: string;
};
export class PartnerCreditEvidenceVerifier {
  constructor(private readonly db: Database) {}
  async verify(evidence: OrphanSettlementCompletionEvidence): Promise<VerifiedPartnerFulfillment | null> {
    return this.db.transaction(async tx => {
      const repos = createRepositories(tx);
      const settlement = await repos.orphanSettlements.lockForUpdate(evidence.settlementRef);
      if (!settlement || settlement.status !== 'fulfilled' ||
          !settlement.fulfilledAt || !settlement.completionAuthorizationId ||
          !settlement.acceptedByUserId || !settlement.completionAuthorizedAt ||
          !settlement.fulfillmentPolicyVersion || !settlement.fulfillmentSnapshot ||
          settlement.claimId !== evidence.claimId ||
          settlement.customerId !== evidence.customerId ||
          settlement.receivingBusinessId !== evidence.receivingBusinessId ||
          settlement.receivingBranchId !== evidence.receivingBranchId ||
          settlement.fulfillmentPolicyVersion !== evidence.fulfillmentPolicyVersion ||
          settlement.fulfillmentReference !== evidence.fulfillmentReference ||
          settlement.fulfilledAt.toISOString() !== evidence.fulfilledAt ||
          evidence.originBusinessId === settlement.receivingBusinessId) return null;
      const claim = await repos.orphanRewardClaims.lockForUpdate(settlement.claimId);
      if (!claim || claim.status !== 'settled' || !claim.settledAt ||
          claim.customerId !== settlement.customerId ||
          claim.originBusinessId !== evidence.originBusinessId ||
          claim.reversedAt) return null;
      const event = await repos.orphanSettlementEvents.findByIdempotencyKey(
        `settlement-fulfilled:${settlement.id}`,
      );
      if (!event || event.eventType !== 'settlement_fulfilled' ||
          event.settlementId !== settlement.id ||
          event.claimId !== claim.id ||
          event.customerId !== claim.customerId ||
          event.originBusinessId !== claim.originBusinessId ||
          event.receivingBusinessId !== settlement.receivingBusinessId ||
          event.receivingBranchId !== settlement.receivingBranchId) return null;
      const events = await repos.orphanSettlementEvents.listForSettlement(settlement.id, { limit: 200 });
      if (events.some(e => e.eventType === 'settlement_reversed')) return null;
      return {
        settlementRef: settlement.id,
        receivingBusinessId: settlement.receivingBusinessId,
        claimId: claim.id,
        originBusinessId: claim.originBusinessId,
        fulfilledAt: settlement.fulfilledAt,
        fulfilledEventId: event.id,
      };
    });
  }
}
