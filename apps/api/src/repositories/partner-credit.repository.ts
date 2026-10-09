import { and, desc, eq } from 'drizzle-orm';
import { partnerCreditAccounts, partnerCreditAwardDecisions, partnerCreditLedger, partnerCreditPolicies } from '../db/schema';
import { BaseRepository } from './base.repository';

/** Read-only foundation. Never exposes credit mutation, minting or Stripe calls. */
export class PartnerCreditRepository extends BaseRepository {
  async findAccountForBusiness(businessId: string) {
    return this.db.query.partnerCreditAccounts.findFirst({
      where: eq(partnerCreditAccounts.businessId, businessId),
    });
  }

  async listLedgerForBusiness(businessId: string, limit = 100) {
    return this.db
      .select({
        id: partnerCreditLedger.id,
        accountId: partnerCreditLedger.accountId,
        entryType: partnerCreditLedger.entryType,
        units: partnerCreditLedger.units,
        occurredAt: partnerCreditLedger.occurredAt,
      })
      .from(partnerCreditLedger)
      .innerJoin(partnerCreditAccounts, eq(partnerCreditLedger.accountId, partnerCreditAccounts.id))
      .where(eq(partnerCreditAccounts.businessId, businessId))
      .orderBy(desc(partnerCreditLedger.occurredAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  async findAwardForBusiness(businessId: string, settlementRef: string) {
    return this.db.query.partnerCreditAwardDecisions.findFirst({
      where: and(eq(partnerCreditAwardDecisions.businessId, businessId), eq(partnerCreditAwardDecisions.settlementRef, settlementRef)),
    });
  }

  async findPolicyByVersion(version: string) {
    return this.db.query.partnerCreditPolicies.findFirst({
      where: eq(partnerCreditPolicies.version, version),
    });
  }
}
