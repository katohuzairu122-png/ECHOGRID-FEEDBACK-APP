import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { hasActiveDisputeHold } from '../partner-credits/partner-credit-dispute.service';
import {
  benefitApplicationIntents, billingPartnerCreditApplications, businessSubscriptions, orphanSettlementEvents, orphanSettlements, partnerCreditAwardDecisions,
  partnerCreditReservations, s08AllocationFreezeItems, s08AllocationFreezes,
} from '../db/schema';

/**
 * Split 08 terminal application writer (D4). INERT: the 0042 guard on `billing_partner_credit_applications` still denies every write outside an isolated
 * disposable database, and nothing in the application calls this class.
 *
 * It persists the ONE immutable "this reservation was applied to this invoice" row that Split 07 later reads as the authority for consuming a credit
 * (CE-1: a request, a webhook, an invoice quote or a caller's assertion is never that authority). Everything it records is resolved server-side from rows
 * Split 08 already owns, never taken from the caller:
 *   - the saga intent for the reservation is in the reconciled `consumed` state with a provider effect (the saga reaches it only through a verified,
 *     attributed provider observation);
 *   - the effect was confirmed no later than the reservation's own deadline (an effect that landed after expiry is held, not silently consumed);
 *   - the benefit the saga expected is exactly the amount frozen for this reservation and invoice by the aggregate allocation (S08-AGG-ROUND/1), in the
 *     same currency, so a substituted amount or invoice cannot be recorded;
 *   - the business has an `active` subscription (the only status eligible to receive a benefit).
 * It never touches lots, accounts or the ledger: moving the credit is the separate Split 07 consumption transaction.
 */
export type HeldEffectClassification =
  | { classification: 'EFFECT_AFTER_RESERVATION_DEADLINE'; heldForReview: true; reservationId: string; intentId: string; providerEffectRef: string; appliedAt: Date; reservationExpiresAt: Date; lateByMs: number }
  | { classification: 'WITHIN_RESERVATION_DEADLINE' | 'NO_RECONCILED_EFFECT'; heldForReview: false; reservationId: string };

export class BenefitTerminalApplicationService {
  constructor(private readonly db: Database) {}

  /**
   * D4-03: read-only classification of a provider effect that landed after its reservation's own deadline. Such an effect is never recorded or consumed
   * (record() and the consumer refuse it), and it is never discarded: the saga intent, provider effect reference and reservation stay exactly as they are
   * and this returns the evidence an operator needs to review and reconcile it. It writes nothing, issues no refund and makes no compensating financial write.
   */
  async classify(input: { reservationId: string; businessId: string }): Promise<HeldEffectClassification> {
    if (!input.reservationId || !input.businessId) throw new Error('S08_APPLICATION_INPUT_INVALID');
    const [reservation] = await this.db.select().from(partnerCreditReservations).where(eq(partnerCreditReservations.id, input.reservationId)).limit(1);
    if (!reservation || reservation.businessId !== input.businessId) throw new Error('S08_APPLICATION_UNKNOWN_RESERVATION');
    const [intent] = await this.db.select().from(benefitApplicationIntents)
      .where(and(eq(benefitApplicationIntents.reservationId, reservation.id), eq(benefitApplicationIntents.businessId, input.businessId))).limit(1);
    if (!intent || intent.state !== 'consumed' || intent.outcome !== 'confirmed' || !intent.providerEffectRef || !intent.appliedAt)
      return { classification: 'NO_RECONCILED_EFFECT', heldForReview: false, reservationId: reservation.id };
    if (intent.appliedAt > reservation.expiresAt)
      return {
        classification: 'EFFECT_AFTER_RESERVATION_DEADLINE', heldForReview: true, reservationId: reservation.id, intentId: intent.id, providerEffectRef: intent.providerEffectRef,
        appliedAt: intent.appliedAt, reservationExpiresAt: reservation.expiresAt, lateByMs: intent.appliedAt.getTime() - reservation.expiresAt.getTime(),
      };
    return { classification: 'WITHIN_RESERVATION_DEADLINE', heldForReview: false, reservationId: reservation.id };
  }

  async record(input: { reservationId: string; businessId: string }): Promise<{ applicationId: string; providerSuccessRef: string; replay: boolean }> {
    if (!input.reservationId || !input.businessId) throw new Error('S08_APPLICATION_INPUT_INVALID');
    return this.db.transaction(async tx => {
      const [reservation] = await tx.select().from(partnerCreditReservations)
        .where(eq(partnerCreditReservations.id, input.reservationId)).for('update');
      if (!reservation || reservation.businessId !== input.businessId) throw new Error('S08_APPLICATION_UNKNOWN_RESERVATION');

      const [existing] = await tx.select().from(billingPartnerCreditApplications)
        .where(eq(billingPartnerCreditApplications.reservationId, reservation.id)).limit(1);
      const [intent] = await tx.select().from(benefitApplicationIntents)
        .where(and(eq(benefitApplicationIntents.reservationId, reservation.id), eq(benefitApplicationIntents.businessId, input.businessId))).for('update');
      if (!intent) throw new Error('S08_APPLICATION_NO_SAGA');
      if (intent.state !== 'consumed' || intent.outcome !== 'confirmed' || !intent.providerEffectRef || !intent.appliedAt)
        throw new Error('S08_APPLICATION_SAGA_NOT_RECONCILED');

      if (existing) {
        // A replay returns the same row; any difference from what the saga now says is a conflict, never an overwrite.
        if (existing.businessId !== input.businessId || existing.providerSuccessRef !== intent.providerEffectRef || existing.invoiceRef !== intent.invoiceRef ||
            existing.unitsApplied !== reservation.units || existing.appliedAt.getTime() !== intent.appliedAt.getTime())
          throw new Error('S08_APPLICATION_REPLAY_CONFLICT');
        return { applicationId: existing.id, providerSuccessRef: existing.providerSuccessRef, replay: true };
      }

      if (reservation.state !== 'reserved') throw new Error('S08_APPLICATION_RESERVATION_NOT_ACTIVE');
      if (intent.appliedAt > reservation.expiresAt) throw new Error('S08_APPLICATION_AFTER_RESERVATION_EXPIRY');
      if (intent.units !== reservation.units) throw new Error('S08_APPLICATION_UNITS_MISMATCH');

      // The credit must still be one Split 07 could consume. Recording an immutable "applied" row for an award that is disputed, reversed or no longer vested
      // would strand the unit as reserved (consumption refuses in those states), so those cases are refused here, before anything is written. These are read
      // without locks (this writer takes no Split 07 lock); consumption re-verifies all of them under lock.
      const [decision] = await tx.select().from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id, reservation.decisionId)).limit(1);
      if (!decision || decision.businessId !== input.businessId || decision.state !== 'vested') throw new Error('S08_APPLICATION_AWARD_NOT_VESTED');
      const [settlement] = await tx.select().from(orphanSettlements).where(eq(orphanSettlements.id, decision.settlementRef)).limit(1);
      if (!settlement || settlement.status !== 'fulfilled' || settlement.receivingBusinessId !== input.businessId) throw new Error('S08_APPLICATION_SETTLEMENT_INVALID');
      const [reversal] = await tx.select({ id: orphanSettlementEvents.id }).from(orphanSettlementEvents)
        .where(and(eq(orphanSettlementEvents.settlementId, settlement.id), eq(orphanSettlementEvents.eventType, 'settlement_reversed'))).limit(1);
      if (reversal) throw new Error('S08_APPLICATION_REVERSAL_PRESENT');
      if (await hasActiveDisputeHold(tx, decision.id)) throw new Error('S08_APPLICATION_DISPUTE_HOLD');

      // The amount actually applied must be the amount the owner-approved allocation froze for this reservation on this invoice.
      const [item] = await tx.select().from(s08AllocationFreezeItems)
        .where(eq(s08AllocationFreezeItems.reservationId, reservation.id)).limit(1);
      if (!item || item.businessId !== input.businessId) throw new Error('S08_APPLICATION_ALLOCATION_MISSING');
      const [freeze] = await tx.select().from(s08AllocationFreezes)
        .where(and(eq(s08AllocationFreezes.id, item.freezeId), eq(s08AllocationFreezes.businessId, input.businessId))).limit(1);
      if (!freeze || freeze.invoiceRef !== intent.invoiceRef || freeze.currency !== intent.currency ||
          item.invoiceIntentRef !== reservation.invoiceIntentRef || BigInt(item.benefitMinor) !== BigInt(intent.expectedBenefitMinor))
        throw new Error('S08_APPLICATION_ALLOCATION_MISMATCH');

      const subscriptions = await tx.select({ id: businessSubscriptions.id, status: businessSubscriptions.status }).from(businessSubscriptions)
        .where(eq(businessSubscriptions.businessId, input.businessId));
      if (subscriptions.length !== 1 || subscriptions[0]!.status !== 'active') throw new Error('S08_APPLICATION_SUBSCRIPTION_NOT_ELIGIBLE');

      const [inserted] = await tx.insert(billingPartnerCreditApplications).values({
        reservationId: reservation.id,
        businessId: input.businessId,
        subscriptionId: subscriptions[0]!.id,
        invoiceRef: intent.invoiceRef,
        providerSuccessRef: intent.providerEffectRef,
        idempotencyKey: `s08-credit-application:v1:${reservation.id}`,
        unitsApplied: reservation.units,
        terminalState: 'applied',
        appliedAt: intent.appliedAt,
      }).returning({ id: billingPartnerCreditApplications.id });
      if (!inserted) throw new Error('S08_APPLICATION_INSERT_FAILED');
      return { applicationId: inserted.id, providerSuccessRef: intent.providerEffectRef, replay: false };
    });
  }
}
