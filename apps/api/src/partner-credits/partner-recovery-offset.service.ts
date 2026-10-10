import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import { partnerCreditAccounts, partnerCreditLedger, partnerCreditRecoveryObligations } from '../db/schema';
import { planPartnerRecoveryOffset } from './partner-recovery-offset.plan';

/** A transaction-local helper; may ONLY run after the originating settlement
 * is locked, verified fulfilled, and its lot and account are locked. */
export async function applyRecoveryAtVest(
  tx: Transaction,
  input: { accountId: string; decisionId: string; settlementRef: string; now: Date; recoveryDue: number },
): Promise<{ offsetUnits: number; availableUnits: number }> {
  if (!Number.isSafeInteger(input.recoveryDue) || input.recoveryDue < 0)
    throw new Error('PARTNER_RECOVERY_ACCOUNT_INVALID');

  const obligations = await tx.select().from(partnerCreditRecoveryObligations)
    .where(and(eq(partnerCreditRecoveryObligations.accountId, input.accountId),
      gt(partnerCreditRecoveryObligations.unitsOutstanding, 0)))
    .orderBy(asc(partnerCreditRecoveryObligations.createdAt),asc(partnerCreditRecoveryObligations.id))
    .for('update');

  const outstanding = obligations.reduce((sum,o) => sum + o.unitsOutstanding,0);
  if (!Number.isSafeInteger(outstanding) || outstanding !== input.recoveryDue)
    throw new Error('PARTNER_RECOVERY_PROJECTION_MISMATCH');

  const plan = planPartnerRecoveryOffset({outstandingUnits:outstanding,newlyVestingUnits:1});
  if (plan.offsetUnits === 0)
    return {offsetUnits:0,availableUnits:1};

  let remaining = plan.offsetUnits;
  for (const obligation of obligations) {
    if (remaining === 0) break;
    const allocated = Math.min(remaining,obligation.unitsOutstanding);
    if (allocated <= 0) continue;
    await tx.insert(partnerCreditLedger).values({
      accountId:input.accountId,
      decisionId:input.decisionId,
      entryType:'recovery_offset',
      units:-allocated,
      idempotencyKey:`partner-recovery-offset:v1:${input.settlementRef}:${obligation.id}`,
      metadata:{obligationId:obligation.id,reversalRef:obligation.reversalRef,offsetUnits:allocated},
    });
    await tx.update(partnerCreditRecoveryObligations).set({
      unitsOutstanding:sql`${partnerCreditRecoveryObligations.unitsOutstanding} - ${allocated}`,
    }).where(eq(partnerCreditRecoveryObligations.id,obligation.id));
    remaining-=allocated;
  }
  if (remaining !== 0) throw new Error('PARTNER_RECOVERY_UNALLOCATED_OFFSET');
  await tx.update(partnerCreditAccounts).set({
    recoveryDue:sql`${partnerCreditAccounts.recoveryDue} - ${plan.offsetUnits}`,
    updatedAt:input.now,
  }).where(eq(partnerCreditAccounts.id,input.accountId));
  return {offsetUnits:plan.offsetUnits,availableUnits:plan.vestAvailableUnits};
}
