import type { Transaction } from '../db/client';
import { unwindCredit, type UnwindResult } from './partner-credit-unwind';

/**
 * Split 07-owned compensating transition, invoked from the authoritative
 * Split 06 reversal transaction AFTER the settlement row has been locked.
 * Does not update Split 06 data or create reversal evidence.
 *
 * Migration 0041 guards remain enabled and prevent economic mutations
 * outside a separate, explicit activation gate.
 *
 * The logic lives in `unwindCredit` (R10): the same routine a future revocation executor will use, so the two cannot diverge. Beyond the provisional, available and
 * consumed-through-invoice cases, a settlement reversal now also succeeds for an EXPIRED credit (`closed_no_effect`), a credit consumed by a recovery-offset vest
 * (`recovery_restored`) and a credit already unwound by an executed revocation (`already_reversed`); for a RESERVED credit it commits with the credit left untouched
 * (`deferred_credit_in_use`, the pending work is derived from persisted state). Anything it cannot prove still throws and rolls the whole Split 06 transaction back.
 */
export class PartnerProvisionalReversalCompensator {
  async compensate(tx: Transaction, input: {
    settlementRef: string;
    businessId: string;
    reversalEventId: string;
  }): Promise<UnwindResult> {
    return unwindCredit(tx, {
      settlementRef: input.settlementRef,
      businessId: input.businessId,
      cause: { source: 'settlement_reversal', reversalEventId: input.reversalEventId },
    });
  }
}
