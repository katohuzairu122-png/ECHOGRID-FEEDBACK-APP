import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { orphanSettlements, partnerCreditAwardDecisions, partnerCreditLots } from '../db/schema';

/**
 * R10 / O2a: the work a deferred settlement reversal leaves behind, DERIVED from persisted state (no deferral table). A credit is pending when its settlement is
 * `reversed`, its award decision is still `vested` (the compensator wrote nothing) and its lot is `reserved` (release authority does not exist yet) or, once a later
 * release has returned it, `available` (the settlement reversal is never retried, so this is the only place the work stays visible). Read-only: it
 * writes, resolves and releases nothing, and the future revocation executor (Block 2) is what finishes these.
 */
export class PartnerCreditDeferredReversalReader {
  constructor(private readonly db: Pick<Database, 'select'>) {}

  async list(input: { businessId?: string } = {}): Promise<Array<{ settlementRef: string; decisionId: string; lotId: string; businessId: string }>> {
    const rows = await this.db.select({
      settlementRef: partnerCreditAwardDecisions.settlementRef, decisionId: partnerCreditAwardDecisions.id, lotId: partnerCreditLots.id, businessId: partnerCreditAwardDecisions.businessId,
    }).from(partnerCreditAwardDecisions)
      .innerJoin(orphanSettlements, eq(orphanSettlements.id, partnerCreditAwardDecisions.settlementRef))
      .innerJoin(partnerCreditLots, eq(partnerCreditLots.decisionId, partnerCreditAwardDecisions.id))
      .where(and(eq(orphanSettlements.status, 'reversed'), eq(partnerCreditAwardDecisions.state, 'vested'), inArray(partnerCreditLots.status, ['reserved', 'available']),
        ...(input.businessId ? [eq(partnerCreditAwardDecisions.businessId, input.businessId)] : [])));
    return rows;
  }
}
