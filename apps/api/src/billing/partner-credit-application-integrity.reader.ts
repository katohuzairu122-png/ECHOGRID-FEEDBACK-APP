import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  billingPartnerCreditApplications, businessSubscriptions,
  partnerCreditAccounts, partnerCreditAwardDecisions,
  partnerCreditLots, partnerCreditReservations,
} from '../db/schema';

/**
 * Relational consistency is necessary but NOT sufficient for Split 08
 * billing authority. This reader does not call Stripe, mutate a ledger,
 * approve application, or produce TrustedApplicationLookup.kind='verified'.
 */
export class PartnerCreditApplicationIntegrityReader {
  constructor(private readonly db: Db) {}

  async inspect(applicationId: string): Promise<{
    kind: 'missing' | 'inconsistent' | 'relations_consistent_unverified';
    reason?: string;
  }> {
    const [application] = await this.db.select().from(billingPartnerCreditApplications)
      .where(eq(billingPartnerCreditApplications.id, applicationId)).limit(1);
    if (!application) return { kind: 'missing' };

    const [reservation] = await this.db.select().from(partnerCreditReservations)
      .where(eq(partnerCreditReservations.id, application.reservationId)).limit(1);
    if (!reservation) return { kind: 'inconsistent', reason: 'RESERVATION_MISSING' };
    const [decision] = await this.db.select().from(partnerCreditAwardDecisions)
      .where(eq(partnerCreditAwardDecisions.id, reservation.decisionId)).limit(1);
    const [lot] = await this.db.select().from(partnerCreditLots)
      .where(eq(partnerCreditLots.id, reservation.lotId)).limit(1);
    const [account] = await this.db.select().from(partnerCreditAccounts)
      .where(eq(partnerCreditAccounts.id, reservation.accountId)).limit(1);
    const [subscription] = await this.db.select().from(businessSubscriptions)
      .where(eq(businessSubscriptions.id, application.subscriptionId)).limit(1);

    if (!decision || !lot || !account || !subscription ||
        reservation.businessId !== application.businessId ||
        decision.businessId !== application.businessId ||
        account.businessId !== application.businessId ||
        subscription.businessId !== application.businessId ||
        lot.decisionId !== decision.id ||
        lot.accountId !== account.id) {
      return { kind: 'inconsistent', reason: 'CROSS_TENANT_OR_LOT_MISMATCH' };
    }
    if (application.unitsApplied !== 1 || reservation.units !== 1 ||
        application.terminalState !== 'applied' ||
        reservation.state !== 'consumed' ||
        !reservation.terminalAt ||
        application.appliedAt.getTime() > reservation.terminalAt.getTime() ||
        application.appliedAt.getTime() > reservation.expiresAt.getTime() ||
        decision.state !== 'vested' || lot.status !== 'consumed') {
      return { kind: 'inconsistent', reason: 'TERMINAL_STATE_OR_TIMESTAMP_MISMATCH' };
    }
    if (!application.invoiceRef || !application.providerSuccessRef ||
        !subscription.stripeSubscriptionId) {
      return { kind: 'inconsistent', reason: 'PROVIDER_REFERENCE_MISSING' };
    }
    // An attacker with database-write access can construct internally
    // consistent rows. Never interpret this as verified Stripe success.
    return { kind: 'relations_consistent_unverified' };
  }
}
