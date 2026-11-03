import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import {
  benefitApplicationIntents, billingPartnerCreditApplications, partnerCreditAccounts, partnerCreditAwardDecisions,
  partnerCreditLots, partnerCreditLedger, partnerCreditRecoveryObligations, partnerCreditReservations,
} from '../db/schema';

/**
 * Split 07-owned compensating transition, invoked from the authoritative
 * Split 06 reversal transaction AFTER the settlement row has been locked.
 * Does not update Split 06 data or create reversal evidence.
 *
 * Migration 0041 guards remain enabled and prevent economic mutations
 * outside a separate, explicit activation gate.
 */
export class PartnerProvisionalReversalCompensator {
  async compensate(tx: Transaction, input: {
    settlementRef: string;
    businessId: string;
    reversalEventId: string;
  }): Promise<'not_awarded' | 'no_credit' | 'reversed' | 'already_reversed' | 'recovery_obligation_created'> {
    const [decision] = await tx.select().from(partnerCreditAwardDecisions)
      .where(eq(partnerCreditAwardDecisions.settlementRef, input.settlementRef)).for('update');
    if (!decision) return 'not_awarded';
    if (decision.businessId !== input.businessId) throw new Error('PARTNER_REVERSAL_TENANT_MISMATCH');
    if (decision.state === 'ineligible' || decision.state === 'cap_exceeded') {
      if (decision.awardUnits !== 0) throw new Error('PARTNER_REVERSAL_INVALID_ZERO_UNIT_DECISION');
      return 'no_credit';
    }
    if (decision.state === 'reversed') {
      const [movement] = await tx.select({ id: partnerCreditLedger.id }).from(partnerCreditLedger)
        .where(eq(partnerCreditLedger.idempotencyKey, `partner-reversal:v1:${decision.settlementRef}`)).limit(1);
      if (!movement) throw new Error('PARTNER_REVERSAL_MISSING_COMPENSATION');
      return 'already_reversed';
    }
    // Consumed, expired or reserved entitlements require independently verified
    // application evidence and dedicated recovery-offset transitions. Available
    // vested units may be reversed only while their exact lot is unencumbered.
    if ((decision.state !== 'provisional' && decision.state !== 'vested') || decision.awardUnits !== 1)
      throw new Error('PARTNER_REVERSAL_RECOVERY_POLICY_NOT_IMPLEMENTED');

    const [lot] = await tx.select().from(partnerCreditLots)
      .where(eq(partnerCreditLots.decisionId, decision.id)).for('update');
    // D4: a credit that was already CONSUMED against an invoice cannot be taken back from the invoice (Split 08 owns that history). The reversal instead
    // originates one recovery obligation that future earned credits offset, preserving the consumption history exactly.
    // Only a lot consumed through an invoice (it has a consumed reservation) takes this path. A lot a recovery debt absorbed at vest, or one set by hand without
    // evidence, still falls through to the original fail-closed error below, exactly as before D4.
    if (decision.state === 'vested' && lot && lot.status === 'consumed') {
      const [consumedReservation] = await tx.select({ id: partnerCreditReservations.id }).from(partnerCreditReservations)
        .where(and(eq(partnerCreditReservations.lotId, lot.id), eq(partnerCreditReservations.state, 'consumed'))).limit(1);
      if (consumedReservation) return this.compensateConsumed(tx, decision, lot, input);
    }
    if (!lot || lot.units !== 1 ||
        !((decision.state === 'provisional' && lot.status === 'provisional' && lot.availableUnits === 0) ||
          (decision.state === 'vested' && lot.status === 'available' && lot.availableUnits === 1)))
      throw new Error('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED');

    const [account] = await tx.select().from(partnerCreditAccounts)
      .where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
    if (!account || account.businessId !== input.businessId ||
        (decision.state === 'provisional' ? account.provisional < 1 : account.available < 1))
      throw new Error('PARTNER_REVERSAL_ACCOUNT_INCONSISTENT');

    const [provisionalEntry] = await tx.select().from(partnerCreditLedger)
      .where(and(eq(partnerCreditLedger.decisionId, decision.id),
        eq(partnerCreditLedger.entryType, 'provisional'))).limit(1);
    if (!provisionalEntry || provisionalEntry.accountId !== account.id || provisionalEntry.units !== 1)
      throw new Error('PARTNER_REVERSAL_MISSING_ORIGINAL_LEDGER');

    await tx.insert(partnerCreditLedger).values({
      accountId: account.id,
      decisionId: decision.id,
      entryType: 'reverse',
      units: -1,
      idempotencyKey: `partner-reversal:v1:${decision.settlementRef}`,
      metadata: { settlementRef: decision.settlementRef, reversalEventId: input.reversalEventId },
    });
    await tx.update(partnerCreditLots).set({
      status: 'reversed',
      availableUnits: 0,
    }).where(eq(partnerCreditLots.id, lot.id));
    await tx.update(partnerCreditAccounts).set({
      ...(decision.state === 'provisional'
        ? { provisional: sql`${partnerCreditAccounts.provisional} - 1` }
        : { available: sql`${partnerCreditAccounts.available} - 1` }),
      updatedAt: new Date(),
    }).where(eq(partnerCreditAccounts.id, account.id));
    await tx.update(partnerCreditAwardDecisions).set({ state: 'reversed' })
      .where(eq(partnerCreditAwardDecisions.id, decision.id));
    return 'reversed';
  }

  /**
   * Consumed-credit reversal (D4), inside the authoritative Split 06 reversal transaction, after the settlement and decision are locked. Every fact it
   * relies on is re-read and re-verified: the consumed reservation, the Split 08 terminal application and reconciled saga, and the original provisional and
   * consume ledger entries. It appends one `consumed_reversal` ledger entry (informational: the debt is not a balance), inserts exactly one recovery
   * obligation keyed by the reversal event, raises the account's recovery_due, and marks the lot and decision reversed. The consumed reservation, the
   * application row and the `consume` entry are never edited: the billing history stays exactly as it was.
   */
  private async compensateConsumed(
    tx: Transaction,
    decision: typeof partnerCreditAwardDecisions.$inferSelect,
    lot: typeof partnerCreditLots.$inferSelect,
    input: { settlementRef: string; businessId: string; reversalEventId: string },
  ): Promise<'recovery_obligation_created'> {
    if (lot.units !== 1 || lot.availableUnits !== 0 || decision.awardUnits !== 1) throw new Error('PARTNER_REVERSAL_CONSUMED_LOT_INCONSISTENT');
    const [account] = await tx.select().from(partnerCreditAccounts).where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
    if (!account || account.businessId !== input.businessId) throw new Error('PARTNER_REVERSAL_ACCOUNT_INCONSISTENT');
    const [reservation] = await tx.select().from(partnerCreditReservations).where(eq(partnerCreditReservations.lotId, lot.id)).for('update');
    if (!reservation || reservation.state !== 'consumed' || reservation.businessId !== input.businessId || reservation.decisionId !== decision.id || reservation.accountId !== account.id)
      throw new Error('PARTNER_REVERSAL_CONSUMPTION_EVIDENCE_MISSING');
    const [application] = await tx.select().from(billingPartnerCreditApplications).where(eq(billingPartnerCreditApplications.reservationId, reservation.id)).limit(1);
    const [intent] = await tx.select().from(benefitApplicationIntents)
      .where(and(eq(benefitApplicationIntents.reservationId, reservation.id), eq(benefitApplicationIntents.businessId, input.businessId))).limit(1);
    if (!application || application.businessId !== input.businessId || application.terminalState !== 'applied' || application.unitsApplied !== 1 ||
        !intent || intent.state !== 'consumed' || intent.outcome !== 'confirmed' || intent.providerEffectRef !== application.providerSuccessRef)
      throw new Error('PARTNER_REVERSAL_CONSUMPTION_EVIDENCE_MISSING');
    const entries = await tx.select().from(partnerCreditLedger).where(eq(partnerCreditLedger.decisionId, decision.id));
    const provisional = entries.filter(e => e.entryType === 'provisional');
    const consume = entries.filter(e => e.entryType === 'consume');
    if (provisional.length !== 1 || provisional[0]!.accountId !== account.id || provisional[0]!.units !== 1) throw new Error('PARTNER_REVERSAL_MISSING_ORIGINAL_LEDGER');
    if (consume.length !== 1 || consume[0]!.accountId !== account.id || consume[0]!.units !== -1) throw new Error('PARTNER_REVERSAL_MISSING_CONSUME_LEDGER');
    if (entries.some(e => e.entryType === 'consumed_reversal' || e.entryType === 'reverse')) throw new Error('PARTNER_REVERSAL_ALREADY_COMPENSATED');

    const now = new Date();
    await tx.insert(partnerCreditRecoveryObligations).values({ accountId: account.id, reversalRef: input.reversalEventId, unitsDue: 1, unitsOutstanding: 1 });
    await tx.insert(partnerCreditLedger).values({
      accountId: account.id, decisionId: decision.id, entryType: 'consumed_reversal', units: 1, idempotencyKey: `partner-reversal:v1:${decision.settlementRef}`,
      metadata: { settlementRef: decision.settlementRef, reversalEventId: input.reversalEventId, reservationId: reservation.id, applicationId: application.id },
    });
    await tx.update(partnerCreditAccounts).set({ recoveryDue: sql`${partnerCreditAccounts.recoveryDue} + 1`, updatedAt: now }).where(eq(partnerCreditAccounts.id, account.id));
    await tx.update(partnerCreditLots).set({ status: 'reversed', availableUnits: 0 }).where(eq(partnerCreditLots.id, lot.id));
    await tx.update(partnerCreditAwardDecisions).set({ state: 'reversed' }).where(eq(partnerCreditAwardDecisions.id, decision.id));
    return 'recovery_obligation_created';
  }
}
