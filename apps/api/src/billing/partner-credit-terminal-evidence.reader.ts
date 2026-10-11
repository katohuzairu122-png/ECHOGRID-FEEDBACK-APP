import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  partnerCreditReservations, billingPartnerCreditApplications,
  businessSubscriptions, partnerCreditAwardDecisions, partnerCreditLots,
} from '../db/schema';

/**
 * Read-only Split 08 verification stage. A persisted "applied" flag and
 * arbitrary provider reference are NOT sufficient to certify Stripe benefit
 * application. No success is returned until a provider-reconciled source
 * of truth is implemented under the separately frozen CE-1 contract.
 */
export class PartnerCreditTerminalEvidenceReader {
  constructor(private readonly db: Database) {}

  async inspect(applicationRef: string, businessId: string) {
    const [application] = await this.db.select().from(billingPartnerCreditApplications)
      .where(eq(billingPartnerCreditApplications.id,applicationRef)).limit(1);
    if (!application || application.businessId !== businessId)
      return {kind:'not_found'} as const;
    const [reservation] = await this.db.select().from(partnerCreditReservations)
      .where(eq(partnerCreditReservations.id,application.reservationId)).limit(1);
    if (!reservation || reservation.businessId !== businessId)
      throw new Error('SPLIT08_APPLICATION_RESERVATION_TENANT_MISMATCH');
    const [decision] = await this.db.select().from(partnerCreditAwardDecisions)
      .where(eq(partnerCreditAwardDecisions.id,reservation.decisionId)).limit(1);
    const [lot] = await this.db.select().from(partnerCreditLots)
      .where(eq(partnerCreditLots.id,reservation.lotId)).limit(1);
    const [subscription] = await this.db.select().from(businessSubscriptions)
      .where(eq(businessSubscriptions.id,application.subscriptionId)).limit(1);
    if (!decision || !lot || !subscription || subscription.businessId !== businessId ||
        decision.businessId !== businessId || decision.id !== lot.decisionId ||
        lot.accountId !== reservation.accountId ||
        application.unitsApplied !== reservation.units)
      throw new Error('SPLIT08_APPLICATION_RELATIONSHIP_MISMATCH');
    // No trusted Stripe invoice confirmation is recorded or verified yet.
    // A row can be inserted during isolated tests, but does NOT authorize
    // consumed-credit reversal or recovery obligation creation.
    return {kind:'not_terminal',reason:'provider_success_not_verified'} as const;
  }
}
