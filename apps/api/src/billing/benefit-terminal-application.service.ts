import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  benefitApplicationIntents, billingPartnerCreditApplications, businessSubscriptions, partnerCreditReservations,
  s08AllocationFreezeItems, s08AllocationFreezes,
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
export class BenefitTerminalApplicationService {
  constructor(private readonly db: Database) {}

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
