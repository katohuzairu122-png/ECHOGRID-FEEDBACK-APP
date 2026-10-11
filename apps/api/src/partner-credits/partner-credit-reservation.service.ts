import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  orphanSettlements, orphanRewardClaims, orphanSettlementEvents,
  partnerCreditAwardDecisions, partnerCreditAccounts, partnerCreditLots,
  partnerCreditReservations, partnerCreditRecoveryObligations,
} from '../db/schema';

/**
 * Internal candidate writer, not exposed to any HTTP, webhook, queue or cron.
 * Both migration 0041 economic guards and 0042 reservation guards remain on.
 * A trusted Split 08 invoice-intent authorization source is STILL REQUIRED.
 */
export class PartnerCreditReservationService {
  constructor(private readonly db: Database) {}

  async reserve(input: {
    settlementRef: string; businessId: string; decisionId: string;
    invoiceIntentRef: string; idempotencyKey: string;
    expiresAt: Date; now?: Date;
  }): Promise<{ state: 'reserved'; reservationId: string; replay: boolean }> {
    if (!input.settlementRef || !input.businessId || !input.decisionId ||
        !input.invoiceIntentRef || !input.idempotencyKey)
      throw new Error('PARTNER_RESERVE_INPUT_INVALID');
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt <= now)
      throw new Error('PARTNER_RESERVE_INVALID_DEADLINE');
    return this.db.transaction(async tx => {
      // Preserve Split 06 / 07 settlement-first order.
      const [settlement] = await tx.select().from(orphanSettlements)
        .where(eq(orphanSettlements.id,input.settlementRef)).for('update');
      if (!settlement || settlement.status !== 'fulfilled' ||
          settlement.receivingBusinessId !== input.businessId)
        throw new Error('PARTNER_RESERVE_SETTLEMENT_INVALID');
      const [claim] = await tx.select().from(orphanRewardClaims)
        .where(eq(orphanRewardClaims.id,settlement.claimId)).for('update');
      if (!claim || claim.status !== 'settled' || claim.reversedAt)
        throw new Error('PARTNER_RESERVE_CLAIM_REVERSED');
      const [reversal] = await tx.select({id:orphanSettlementEvents.id}).from(orphanSettlementEvents)
        .where(and(eq(orphanSettlementEvents.settlementId,settlement.id),
          eq(orphanSettlementEvents.eventType,'settlement_reversed'))).limit(1);
      if (reversal) throw new Error('PARTNER_RESERVE_REVERSAL_PRESENT');
      const [decision] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id,input.decisionId)).for('update');
      if (!decision || decision.settlementRef !== settlement.id ||
          decision.businessId !== input.businessId || decision.state !== 'vested')
        throw new Error('PARTNER_RESERVE_AWARD_NOT_VESTED');
      const [lot] = await tx.select().from(partnerCreditLots)
        .where(eq(partnerCreditLots.decisionId,decision.id)).for('update');
      if (!lot) throw new Error('PARTNER_RESERVE_LOT_MISSING');

      // Idempotency does not turn a released or consumed record back into a
      // reservation, and must never alias a different billing intent.
      const [existing] = await tx.select().from(partnerCreditReservations)
        .where(eq(partnerCreditReservations.idempotencyKey,input.idempotencyKey)).limit(1);
      if (existing) {
        if (existing.state !== 'reserved' || existing.businessId !== input.businessId ||
            existing.decisionId !== decision.id || existing.lotId !== lot.id ||
            existing.invoiceIntentRef !== input.invoiceIntentRef ||
            existing.expiresAt.getTime() !== input.expiresAt.getTime())
          throw new Error('PARTNER_RESERVE_REPLAY_CONFLICT');
        return {state:'reserved',reservationId:existing.id,replay:true};
      }
      if (lot.status !== 'available' || lot.availableUnits !== 1 ||
          !lot.expiresAt || lot.expiresAt <= now || input.expiresAt > lot.expiresAt)
        throw new Error('PARTNER_RESERVE_LOT_NOT_ELIGIBLE');
      const [account] = await tx.select().from(partnerCreditAccounts)
        .where(eq(partnerCreditAccounts.id,lot.accountId)).for('update');
      if (!account || account.businessId !== input.businessId ||
          account.available < 1 || account.recoveryDue !== 0)
        throw new Error('PARTNER_RESERVE_ACCOUNT_NOT_ELIGIBLE');
      const [due] = await tx.select({id:partnerCreditRecoveryObligations.id})
        .from(partnerCreditRecoveryObligations)
        .where(and(eq(partnerCreditRecoveryObligations.accountId,account.id),
          sql`${partnerCreditRecoveryObligations.unitsOutstanding} > 0`)).limit(1);
      if (due) throw new Error('PARTNER_RESERVE_RECOVERY_OUTSTANDING');
      const [inserted] = await tx.insert(partnerCreditReservations).values({
        businessId:input.businessId,decisionId:decision.id,lotId:lot.id,
        accountId:account.id,invoiceIntentRef:input.invoiceIntentRef,
        idempotencyKey:input.idempotencyKey,expiresAt:input.expiresAt,
        state:'reserved',units:1,
      }).returning({id:partnerCreditReservations.id});
      if (!inserted) throw new Error('PARTNER_RESERVE_INSERT_FAILED');
      await tx.update(partnerCreditLots).set({status:'reserved',availableUnits:0})
        .where(eq(partnerCreditLots.id,lot.id));
      await tx.update(partnerCreditAccounts).set({
        available:sql`${partnerCreditAccounts.available} - 1`,
        reserved:sql`${partnerCreditAccounts.reserved} + 1`,
        updatedAt:now,
      }).where(eq(partnerCreditAccounts.id,account.id));
      return {state:'reserved',reservationId:inserted.id,replay:false};
    });
  }

  async release(input: { reservationId: string; businessId: string; now?: Date }) {
    const now=input.now ?? new Date();
    return this.db.transaction(async tx => {
      const [ref] = await tx.select().from(partnerCreditReservations)
        .where(eq(partnerCreditReservations.id,input.reservationId));
      if (!ref || ref.businessId !== input.businessId) throw new Error('PARTNER_RELEASE_UNKNOWN_RESERVATION');
      const [decisionRef] = await tx.select({settlementRef:partnerCreditAwardDecisions.settlementRef})
        .from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id,ref.decisionId));
      if (!decisionRef) throw new Error('PARTNER_RELEASE_DECISION_MISSING');
      const [settlement] = await tx.select().from(orphanSettlements)
        .where(eq(orphanSettlements.id,decisionRef.settlementRef)).for('update');
      if (!settlement || settlement.receivingBusinessId !== input.businessId)
        throw new Error('PARTNER_RELEASE_SETTLEMENT_MISMATCH');
      const [decision] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id,ref.decisionId)).for('update');
      const [lot] = await tx.select().from(partnerCreditLots)
        .where(eq(partnerCreditLots.id,ref.lotId)).for('update');
      if (!decision || !lot || lot.decisionId !== decision.id)
        throw new Error('PARTNER_RELEASE_LOT_MISMATCH');
      const [account] = await tx.select().from(partnerCreditAccounts)
        .where(eq(partnerCreditAccounts.id,ref.accountId)).for('update');
      const [reservation] = await tx.select().from(partnerCreditReservations)
        .where(eq(partnerCreditReservations.id,input.reservationId)).for('update');
      if (!account || account.businessId !== input.businessId ||
          !reservation || reservation.lotId !== lot.id)
        throw new Error('PARTNER_RELEASE_ACCOUNT_MISMATCH');
      if (reservation.state === 'released') return 'already_released' as const;
      if (reservation.state !== 'reserved' || account.reserved < 1 ||
          lot.status !== 'reserved' || decision.state !== 'vested')
        throw new Error('PARTNER_RELEASE_NOT_RELEASABLE');
      // CE-1 requires authoritative provider failure/cancellation verification;
      // with no such source wired, the service may not release anything.
      throw new Error('SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED');
    });
  }
}
