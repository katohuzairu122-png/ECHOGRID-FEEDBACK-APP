import { and, eq, sql } from 'drizzle-orm';
import { applyRecoveryAtVest } from './partner-recovery-offset.service';
import type { Database } from '../db/client';
import {
  orphanRewardClaims, orphanSettlementEvents, orphanSettlements,
  partnerCreditAccounts, partnerCreditAwardDecisions, partnerCreditLedger,
  partnerCreditLots, partnerCreditPolicies,
} from '../db/schema';

/** UTC anniversary preserving the calendar month (clamp Feb 29 when necessary). */
export function partnerExpiryAt(vestedAt: Date): Date {
  if (!Number.isFinite(vestedAt.getTime())) throw new Error('PARTNER_VEST_INVALID_TIME');
  const year = vestedAt.getUTCFullYear() + 1;
  const month = vestedAt.getUTCMonth();
  const day = Math.min(vestedAt.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day, vestedAt.getUTCHours(),
    vestedAt.getUTCMinutes(), vestedAt.getUTCSeconds(), vestedAt.getUTCMilliseconds()));
}

/**
 * Internal Split 07 lifecycle. No HTTP, queue, or cron invoker. Economic
 * mutation triggers from migration 0041 remain intact; this is inert in
 * ordinary/production databases pending a separate activation authorization.
 */
export class PartnerCreditLifecycleService {
  constructor(private readonly db: Database) {}

  async vest(decisionId: string, now = new Date()) {
    return this.db.transaction(async tx => {
      const [decisionRef] = await tx.select({ settlementRef: partnerCreditAwardDecisions.settlementRef })
        .from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id, decisionId));
      if (!decisionRef) return 'not_found' as const;
      // Reversal and award lock the settlement first; never lock the decision
      // before it or a concurrent reverse could deadlock.
      const [settlement] = await tx.select().from(orphanSettlements)
        .where(eq(orphanSettlements.id, decisionRef.settlementRef)).for('update');
      if (!settlement || settlement.status !== 'fulfilled' || !settlement.fulfilledAt)
        throw new Error('PARTNER_VEST_SETTLEMENT_NOT_FULFILLED');
      const [claim] = await tx.select().from(orphanRewardClaims)
        .where(eq(orphanRewardClaims.id, settlement.claimId)).for('update');
      if (!claim || claim.status !== 'settled' || claim.reversedAt ||
          claim.customerId !== settlement.customerId)
        throw new Error('PARTNER_VEST_CLAIM_NOT_SETTLED');
      const [reversalEvent] = await tx.select({id: orphanSettlementEvents.id})
        .from(orphanSettlementEvents).where(and(
          eq(orphanSettlementEvents.settlementId, settlement.id),
          eq(orphanSettlementEvents.eventType, 'settlement_reversed'))).limit(1);
      if (reversalEvent) throw new Error('PARTNER_VEST_REVERSED_HISTORY');

      const [decision] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id, decisionId)).for('update');
      if (!decision || decision.settlementRef !== settlement.id ||
          decision.businessId !== settlement.receivingBusinessId ||
          decision.fulfilledAt.toISOString() !== settlement.fulfilledAt.toISOString())
        throw new Error('PARTNER_VEST_DECISION_MISMATCH');
      if (decision.state === 'vested') return 'already_vested' as const;
      if (decision.state !== 'provisional' || decision.awardUnits !== 1 ||
          !decision.vestAt || decision.vestAt.getTime() > now.getTime() ||
          decision.fulfilledAt.getTime() + 14*86400_000 > now.getTime())
        throw new Error('PARTNER_VEST_NOT_ELIGIBLE');
      const [policy] = await tx.select().from(partnerCreditPolicies)
        .where(eq(partnerCreditPolicies.id, decision.policyId));
      if (!policy || policy.awardUnits !== 1 || policy.vestDays !== 14 ||
          policy.expiresAfterMonths !== 12)
        throw new Error('PARTNER_VEST_POLICY_MISMATCH');
      const [lot] = await tx.select().from(partnerCreditLots)
        .where(eq(partnerCreditLots.decisionId, decision.id)).for('update');
      if (!lot || lot.status !== 'provisional' || lot.units !== 1 ||
          lot.availableUnits !== 0 || lot.vestAt.getTime() !== decision.vestAt.getTime())
        throw new Error('PARTNER_VEST_LOT_INVALID');
      const [account] = await tx.select().from(partnerCreditAccounts)
        .where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
      if (!account || account.businessId !== decision.businessId || account.provisional < 1)
        throw new Error('PARTNER_VEST_ACCOUNT_INVALID');
      // FIFO recovery offsets run inside this same settlement-locked vesting
      // transaction. Existing debt receives the newly vesting unit before any
      // credit becomes available for a future Split 08 reservation.
      const recovery = await applyRecoveryAtVest(tx, {
        accountId:account.id,decisionId:decision.id,
        settlementRef:decision.settlementRef,now,recoveryDue:account.recoveryDue,
      });
      const expiresAt = partnerExpiryAt(now);
      await tx.insert(partnerCreditLedger).values({
        accountId: account.id, decisionId: decision.id, entryType: 'vest', units: 1,
        idempotencyKey: `partner-vest:v1:${decision.settlementRef}`,
        metadata: { movedFrom: 'provisional', expiresAt: expiresAt.toISOString(),
          recoveryOffsetUnits: recovery.offsetUnits },
      });
      await tx.update(partnerCreditLots).set({
        status: recovery.availableUnits === 1 ? 'available' : 'consumed',
        availableUnits: recovery.availableUnits, expiresAt,
      }).where(eq(partnerCreditLots.id, lot.id));
      await tx.update(partnerCreditAccounts).set({
        provisional: sql`${partnerCreditAccounts.provisional} - 1`,
        available: sql`${partnerCreditAccounts.available} + ${recovery.availableUnits}`,
        updatedAt: now,
      }).where(eq(partnerCreditAccounts.id, account.id));
      await tx.update(partnerCreditAwardDecisions).set({state:'vested'})
        .where(eq(partnerCreditAwardDecisions.id, decision.id));
      return 'vested' as const;
    });
  }

  async expire(decisionId: string, now = new Date()) {
    return this.db.transaction(async tx => {
      const [reference] = await tx.select({settlementRef:partnerCreditAwardDecisions.settlementRef})
        .from(partnerCreditAwardDecisions).where(eq(partnerCreditAwardDecisions.id,decisionId));
      if (!reference) return 'not_found' as const;
      // Same global lock order as reversal and vest.
      const [settlement] = await tx.select({id:orphanSettlements.id})
        .from(orphanSettlements).where(eq(orphanSettlements.id,reference.settlementRef)).for('update');
      if (!settlement) throw new Error('PARTNER_EXPIRY_SETTLEMENT_MISSING');
      const [decision] = await tx.select().from(partnerCreditAwardDecisions)
        .where(eq(partnerCreditAwardDecisions.id,decisionId)).for('update');
      if (!decision || decision.state !== 'vested') throw new Error('PARTNER_EXPIRY_NOT_VESTED');
      const [lot] = await tx.select().from(partnerCreditLots)
        .where(eq(partnerCreditLots.decisionId,decisionId)).for('update');
      if (lot?.status === 'expired') return 'already_expired' as const;
      if (!lot || lot.status !== 'available' || lot.availableUnits !== 1 ||
          !lot.expiresAt || lot.expiresAt > now)
        throw new Error('PARTNER_EXPIRY_NOT_ELIGIBLE');
      const [account] = await tx.select().from(partnerCreditAccounts)
        .where(eq(partnerCreditAccounts.id,lot.accountId)).for('update');
      if (!account || account.businessId !== decision.businessId || account.available < 1)
        throw new Error('PARTNER_EXPIRY_ACCOUNT_INVALID');
      await tx.insert(partnerCreditLedger).values({
        accountId:account.id,decisionId,entryType:'expire',units:-1,
        idempotencyKey:`partner-expire:v1:${decision.settlementRef}`,
        metadata:{reason:'12_month_anniversary',expiresAt:lot.expiresAt.toISOString()},
      });
      await tx.update(partnerCreditLots).set({status:'expired',availableUnits:0})
        .where(eq(partnerCreditLots.id,lot.id));
      await tx.update(partnerCreditAccounts).set({
        available:sql`${partnerCreditAccounts.available} - 1`,updatedAt:now,
      }).where(eq(partnerCreditAccounts.id,account.id));
      return 'expired' as const;
    });
  }
}
