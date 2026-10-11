import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  orphanSettlements, partnerCreditReservations, partnerCreditAwardDecisions,
  partnerCreditLots, partnerCreditAccounts, billingPartnerCreditApplications,
  businessSubscriptions,
} from '../db/schema';

/**
 * A consistency inspection, NOT a declaration of provider success.
 * Never interpret this result as permission to mutate credit economics.
 *
 * Lock order: settlement -> decision -> lot -> account -> reservation ->
 * subscription -> application. Split 08 provider verification must happen
 * outside this database transaction and be rebound to immutable invoice facts.
 */
export class Split08Ce1TenantIntegrityVerifier {
  constructor(private readonly db: Database) {}

  async inspect(reservationId: string): Promise<{
    reservationId: string;
    businessId: string;
    invoiceRef: string;
    providerSuccessRef: string;
    structurallyConsistent: true;
    providerVerified: false;
  }> {
    return this.db.transaction(async tx => {
      const [reference] = await tx.select().from(partnerCreditReservations)
        .where(eq(partnerCreditReservations.id,reservationId));
      if (!reference) throw new Error('CE1_RESERVATION_NOT_FOUND');

      const [decisionRef] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id,reference.decisionId));
      if (!decisionRef) throw new Error('CE1_DECISION_NOT_FOUND');

      const [settlement] = await tx.select().from(orphanSettlements)
        .where(eq(orphanSettlements.id,decisionRef.settlementRef)).for('update');
      if (!settlement || settlement.receivingBusinessId !== reference.businessId)
        throw new Error('CE1_SETTLEMENT_TENANT_MISMATCH');

      const [decision] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id,reference.decisionId)).for('update');
      const [lot] = await tx.select().from(partnerCreditLots)
        .where(eq(partnerCreditLots.id,reference.lotId)).for('update');
      if (!decision || !lot || decision.businessId !== reference.businessId ||
          decision.settlementRef !== settlement.id || lot.decisionId !== decision.id ||
          decision.state !== 'vested' || lot.status !== 'consumed' ||
          lot.availableUnits !== 0)
        throw new Error('CE1_DECISION_LOT_TENANT_MISMATCH');

      const [account] = await tx.select().from(partnerCreditAccounts)
        .where(eq(partnerCreditAccounts.id,reference.accountId)).for('update');
      if (!account || account.businessId !== reference.businessId ||
          lot.accountId !== account.id)
        throw new Error('CE1_ACCOUNT_TENANT_MISMATCH');

      const [reservation] = await tx.select().from(partnerCreditReservations)
        .where(eq(partnerCreditReservations.id,reservationId)).for('update');
      if (!reservation || reservation.businessId !== reference.businessId ||
          reservation.decisionId !== decision.id ||
          reservation.lotId !== lot.id ||
          reservation.accountId !== account.id ||
          reservation.units !== 1)
        throw new Error('CE1_RESERVATION_CHANGED');

      const [application] = await tx.select().from(billingPartnerCreditApplications)
        .where(eq(billingPartnerCreditApplications.reservationId,reservationId)).for('update');
      if (!application) throw new Error('CE1_TERMINAL_APPLICATION_NOT_FOUND');

      const [subscription] = await tx.select().from(businessSubscriptions)
        .where(eq(businessSubscriptions.id,application.subscriptionId)).for('update');
      if (!subscription || subscription.businessId !== reservation.businessId ||
          application.businessId !== reservation.businessId ||
          application.unitsApplied !== reservation.units ||
          application.terminalState !== 'applied' ||
          reservation.state !== 'consumed' ||
          !reservation.terminalAt ||
          application.appliedAt > reservation.terminalAt ||
          application.appliedAt > reservation.expiresAt)
        throw new Error('CE1_APPLICATION_TENANT_OR_TERMINAL_MISMATCH');

      // A string saved in our DB is not independently validated Stripe proof.
      // This API deliberately returns providerVerified:false even on success.
      return {
        reservationId, businessId:reservation.businessId,
        invoiceRef:application.invoiceRef,
        providerSuccessRef:application.providerSuccessRef,
        structurallyConsistent:true as const,
        providerVerified:false as const,
      };
    });
  }
}
