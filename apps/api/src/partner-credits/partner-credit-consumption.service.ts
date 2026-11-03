import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { hasActiveDisputeHold } from './partner-credit-dispute.service';
import {
  benefitApplicationIntents, billingPartnerCreditApplications, orphanSettlementEvents, orphanSettlements,
  partnerCreditAccounts, partnerCreditAwardDecisions, partnerCreditLedger, partnerCreditLots, partnerCreditReservations,
} from '../db/schema';

/**
 * Split 07 final credit consumption (D4). INERT: the 0041/0042 guards still deny every write outside an isolated disposable database, and no route, queue
 * or cron calls this class. It is the transaction that moves ONE reserved Partner Credit unit to consumed, and it does so only after reading the
 * authoritative Split 08 terminal application row itself (CE-1 "Split 07 moves reserved to consumed ONLY after successfully reading that verified terminal
 * row"). Nothing the caller supplies is evidence: the caller names a reservation and a business, and everything else is resolved and re-verified under lock.
 *
 * Lock order (CE-1, same as reservation/release): settlement, then award decision, lot, account, then the reservation. The application and saga rows
 * are only read. A race against reversal, release, expiry or a dispute hold loses closed: nothing is written and the unit stays reserved.
 *
 * One transaction writes four things that must agree: the reservation becomes `consumed` (terminal), the lot becomes `consumed`, the account's reserved
 * bucket drops by one, and exactly one `consume` (-1) ledger entry is appended (idempotency key `partner-consume:v1:<reservationId>`). Together they keep the
 * ledger identity (the sum of the counted ledger entries equals provisional + available + reserved). The database re-verifies the evidence by trigger.
 *
 * Decisions that are mine, not the owner's, flagged for ratification: consumption is refused while an award dispute hold is active (the unit stays reserved
 * until the hold is resolved), and an application confirmed after the reservation's own deadline is refused (see BenefitTerminalApplicationService).
 */
export class PartnerCreditConsumptionService {
  constructor(private readonly db: Database) {}

  async consume(input: { reservationId: string; businessId: string; now?: Date }): Promise<{ state: 'consumed'; replay: boolean; ledgerKey: string }> {
    if (!input.reservationId || !input.businessId) throw new Error('PARTNER_CONSUME_INPUT_INVALID');
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('PARTNER_CONSUME_INVALID_TIME');
    const ledgerKey = `partner-consume:v1:${input.reservationId}`;
    return this.db.transaction(async tx => {
      // Unlocked reads only to learn the lock chain (settlement first), as the release path does; everything is re-read under lock below.
      const [probe] = await tx.select({ businessId: partnerCreditReservations.businessId, decisionId: partnerCreditReservations.decisionId })
        .from(partnerCreditReservations).where(eq(partnerCreditReservations.id, input.reservationId));
      if (!probe || probe.businessId !== input.businessId) throw new Error('PARTNER_CONSUME_UNKNOWN_RESERVATION');
      const [decisionRef] = await tx.select({ settlementRef: partnerCreditAwardDecisions.settlementRef }).from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id, probe.decisionId));
      if (!decisionRef) throw new Error('PARTNER_CONSUME_DECISION_MISSING');

      const [settlement] = await tx.select().from(orphanSettlements).where(eq(orphanSettlements.id, decisionRef.settlementRef)).for('update');
      if (!settlement || settlement.receivingBusinessId !== input.businessId) throw new Error('PARTNER_CONSUME_SETTLEMENT_INVALID');
      const [decision] = await tx.select().from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id, probe.decisionId)).for('update');
      if (!decision || decision.settlementRef !== settlement.id || decision.businessId !== input.businessId || decision.awardUnits !== 1) throw new Error('PARTNER_CONSUME_AWARD_NOT_VESTED');
      const [lot] = await tx.select().from(partnerCreditLots).where(eq(partnerCreditLots.decisionId, decision.id)).for('update');
      if (!lot || lot.units !== 1) throw new Error('PARTNER_CONSUME_LOT_MISSING');
      const [account] = await tx.select().from(partnerCreditAccounts).where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
      if (!account || account.businessId !== input.businessId) throw new Error('PARTNER_CONSUME_ACCOUNT_MISMATCH');
      const [reservation] = await tx.select().from(partnerCreditReservations).where(eq(partnerCreditReservations.id, input.reservationId)).for('update');
      if (!reservation || reservation.lotId !== lot.id || reservation.accountId !== account.id || reservation.decisionId !== decision.id || reservation.units !== 1)
        throw new Error('PARTNER_CONSUME_RESERVATION_MISMATCH');

      const [application] = await tx.select().from(billingPartnerCreditApplications).where(eq(billingPartnerCreditApplications.reservationId, reservation.id)).limit(1);
      if (!application) throw new Error('PARTNER_CONSUME_APPLICATION_MISSING');
      const [intent] = await tx.select().from(benefitApplicationIntents)
        .where(and(eq(benefitApplicationIntents.reservationId, reservation.id), eq(benefitApplicationIntents.businessId, input.businessId))).limit(1);
      if (application.businessId !== input.businessId || application.terminalState !== 'applied' || application.unitsApplied !== reservation.units ||
          !intent || intent.state !== 'consumed' || intent.outcome !== 'confirmed' || intent.providerEffectRef !== application.providerSuccessRef || intent.invoiceRef !== application.invoiceRef)
        throw new Error('PARTNER_CONSUME_APPLICATION_NOT_AUTHORITATIVE');
      if (application.appliedAt > reservation.expiresAt) throw new Error('PARTNER_CONSUME_APPLICATION_AFTER_EXPIRY');

      // Replay is decided BEFORE the "still vested / not reversed" gates, so a retry after the credit was consumed and later reversed still returns the same
      // result and writes nothing. A consumed reservation whose sides disagree is a conflict, never a silent success.
      const [entry] = await tx.select().from(partnerCreditLedger).where(eq(partnerCreditLedger.idempotencyKey, ledgerKey)).limit(1);
      if (reservation.state === 'consumed') {
        const entryOk = !!entry && entry.entryType === 'consume' && entry.units === -1 && entry.accountId === account.id && entry.decisionId === decision.id;
        let lotOk = lot.status === 'consumed' && decision.state === 'vested';
        if (lot.status === 'reversed' && decision.state === 'reversed') {
          // consumed and later reversed: the reversal must have left its own consumed_reversal entry, otherwise the sides disagree
          const [reversalEntry] = await tx.select({ id: partnerCreditLedger.id }).from(partnerCreditLedger)
            .where(and(eq(partnerCreditLedger.decisionId, decision.id), eq(partnerCreditLedger.entryType, 'consumed_reversal'))).limit(1);
          lotOk = !!reversalEntry;
        }
        if (!entryOk || !lotOk) throw new Error('PARTNER_CONSUME_REPLAY_CONFLICT');
        return { state: 'consumed', replay: true, ledgerKey };
      }

      if (settlement.status !== 'fulfilled') throw new Error('PARTNER_CONSUME_SETTLEMENT_INVALID');
      const [reversal] = await tx.select({ id: orphanSettlementEvents.id }).from(orphanSettlementEvents)
        .where(and(eq(orphanSettlementEvents.settlementId, settlement.id), eq(orphanSettlementEvents.eventType, 'settlement_reversed'))).limit(1);
      if (reversal) throw new Error('PARTNER_CONSUME_REVERSAL_PRESENT');
      if (decision.state !== 'vested') throw new Error('PARTNER_CONSUME_AWARD_NOT_VESTED');
      if (entry) throw new Error('PARTNER_CONSUME_LEDGER_WITHOUT_CONSUMPTION');
      if (reservation.state !== 'reserved' || lot.status !== 'reserved' || lot.availableUnits !== 0 || account.reserved < 1) throw new Error('PARTNER_CONSUME_NOT_CONSUMABLE');
      if (await hasActiveDisputeHold(tx, decision.id)) throw new Error('PARTNER_CONSUME_DISPUTE_HOLD');

      await tx.update(partnerCreditReservations).set({ state: 'consumed', terminalAt: now }).where(eq(partnerCreditReservations.id, reservation.id));
      await tx.update(partnerCreditLots).set({ status: 'consumed', availableUnits: 0 }).where(eq(partnerCreditLots.id, lot.id));
      await tx.update(partnerCreditAccounts).set({ reserved: sql`${partnerCreditAccounts.reserved} - 1`, updatedAt: now }).where(eq(partnerCreditAccounts.id, account.id));
      await tx.insert(partnerCreditLedger).values({
        accountId: account.id, decisionId: decision.id, entryType: 'consume', units: -1, idempotencyKey: ledgerKey,
        metadata: { reservationId: reservation.id, applicationId: application.id, invoiceRef: application.invoiceRef, providerSuccessRef: application.providerSuccessRef },
        occurredAt: now,
      });
      return { state: 'consumed', replay: false, ledgerKey };
    });
  }
}
