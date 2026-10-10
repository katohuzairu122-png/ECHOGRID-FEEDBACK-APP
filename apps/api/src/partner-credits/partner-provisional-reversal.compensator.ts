import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import {
  partnerCreditAccounts, partnerCreditAwardDecisions,
  partnerCreditLots, partnerCreditLedger,
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
  }): Promise<'not_awarded' | 'no_credit' | 'reversed' | 'already_reversed'> {
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
      provisional: sql`${partnerCreditAccounts.provisional} - 1`,
      updatedAt: new Date(),
    }).where(eq(partnerCreditAccounts.id, account.id));
    await tx.update(partnerCreditAwardDecisions).set({ state: 'reversed' })
      .where(eq(partnerCreditAwardDecisions.id, decision.id));
    return 'reversed';
  }
}
