import { and, asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import {
  benefitApplicationIntents, billingPartnerCreditApplications, partnerCreditAccounts, partnerCreditAwardDecisions,
  partnerCreditLots, partnerCreditLedger, partnerCreditRecoveryObligations, partnerCreditReservations,
} from '../db/schema';

/**
 * The ONE routine that unwinds a Partner Credit award (R10, Block 1). INERT: the 0041/0042/0053 guards stay enabled and deny these writes outside an isolated
 * disposable database, and no route, queue or cron calls it except the Split 06 reversal transaction through `PartnerProvisionalReversalCompensator`.
 * A future revocation executor (Block 2) is the other intended caller; sharing one routine keeps the two from diverging.
 *
 * The caller must already hold the settlement lock. Lock order inside: decision, lot, account, recovery obligations (ordered by creation then id, exactly as the vest
 * offset does), reservation. Every case writes its LEDGER EVIDENCE FIRST (the database re-verifies it before the lot or obligation moves) and is exactly-once: a decision
 * has at most one reversal-class ledger entry, always under the canonical key `partner-reversal:v1:<settlementRef>`, so an executed revocation followed by a settlement
 * reversal (or the reverse order) produces exactly one financial consequence. Anything it cannot prove throws and rolls the caller's transaction back (fail closed).
 *
 * Cases (decision state, lot state):
 *   provisional, provisional      -> `reverse` -1, provisional bucket -1                      (existing)
 *   vested, available             -> `reverse` -1, available bucket -1                        (existing)
 *   vested, consumed through an invoice -> `consumed_reversal`, one recovery obligation      (D4)
 *   vested, consumed by a recovery-offset vest -> `recovery_restored`, the exact offset is reinstated on its obligation   (R10, G2)
 *   vested, expired               -> `reversal_noop`, no balance effect                       (R10, G1)
 *   vested, reserved              -> NOTHING is written: 'deferred_credit_in_use' (the credit side waits for release authority; the pending work is derived from
 *                                    persisted state by `PartnerCreditDeferredReversalReader`, no new table)   (R10, O2a)
 *   decision already reversed     -> 'already_reversed' (requires the canonical ledger row)
 * Everything else throws PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED or PARTNER_REVERSAL_RECOVERY_POLICY_NOT_IMPLEMENTED, as before.
 */
export type UnwindCause =
  | { source: 'settlement_reversal'; reversalEventId: string }
  | { source: 'revocation'; correctionId: string };

export type UnwindResult =
  | 'not_awarded' | 'no_credit' | 'reversed' | 'already_reversed' | 'recovery_obligation_created'
  | 'closed_no_effect' | 'recovery_restored' | 'deferred_credit_in_use';

type Decision = typeof partnerCreditAwardDecisions.$inferSelect;
type Lot = typeof partnerCreditLots.$inferSelect;
type Input = { settlementRef: string; businessId: string; cause: UnwindCause };

/** The id that plays the role of the Split 06 reversal event id: the reversal event itself, or the approved correction for a revocation. */
const causeRef = (c: UnwindCause) => (c.source === 'settlement_reversal' ? c.reversalEventId : c.correctionId);
/** Settlement reversals keep their historic metadata shape unchanged; a revocation adds its source and correction id so the cause stays distinguishable. */
const causeMeta = (c: UnwindCause): Record<string, unknown> =>
  c.source === 'settlement_reversal' ? { reversalEventId: c.reversalEventId } : { reversalEventId: c.correctionId, source: 'revocation', correctionId: c.correctionId };
const canonicalKey = (d: Decision) => `partner-reversal:v1:${d.settlementRef}`;

export async function unwindCredit(tx: Transaction, input: Input): Promise<UnwindResult> {
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
      .where(eq(partnerCreditLedger.idempotencyKey, canonicalKey(decision))).limit(1);
    if (!movement) throw new Error('PARTNER_REVERSAL_MISSING_COMPENSATION');
    return 'already_reversed';
  }
  if ((decision.state !== 'provisional' && decision.state !== 'vested') || decision.awardUnits !== 1)
    throw new Error('PARTNER_REVERSAL_RECOVERY_POLICY_NOT_IMPLEMENTED');

  const [lot] = await tx.select().from(partnerCreditLots).where(eq(partnerCreditLots.decisionId, decision.id)).for('update');

  if (decision.state === 'vested' && lot) {
    if (lot.status === 'consumed') {
      // A credit consumed through an invoice has a consumed reservation (D4); one a recovery debt absorbed at vest has none (R10, G2).
      const [consumedReservation] = await tx.select({ id: partnerCreditReservations.id }).from(partnerCreditReservations)
        .where(and(eq(partnerCreditReservations.lotId, lot.id), eq(partnerCreditReservations.state, 'consumed'))).limit(1);
      if (consumedReservation) return compensateConsumed(tx, decision, lot, input);
      return restoreOffsetConsumed(tx, decision, lot, input);
    }
    if (lot.status === 'expired') return closeExpired(tx, decision, lot, input);
    if (lot.status === 'reserved') {
      if (lot.units !== 1 || lot.availableUnits !== 0) throw new Error('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED');
      // Nothing is written, but the credit is VALIDATED and its reservation is LOCKED (account, then reservation, the shared order): the saga's begin_apply holds this same
      // reservation lock, so a provider attempt and this reversal serialize; an attempt that began first is visible as a started intent and is handled as policy case D.
      const [account] = await tx.select().from(partnerCreditAccounts).where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
      const [reservation] = await tx.select().from(partnerCreditReservations).where(eq(partnerCreditReservations.lotId, lot.id)).for('update');
      if (!account || account.businessId !== input.businessId || account.reserved < 1 ||
          !reservation || reservation.state !== 'reserved' || reservation.businessId !== input.businessId || reservation.decisionId !== decision.id || reservation.accountId !== account.id)
        throw new Error('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED');
      return 'deferred_credit_in_use';
    }
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
    idempotencyKey: canonicalKey(decision),
    metadata: { settlementRef: decision.settlementRef, ...causeMeta(input.cause) },
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
 * Consumed-credit reversal (D4), after the settlement and decision are locked. Every fact it relies on is re-read and re-verified: the consumed reservation, the Split 08
 * terminal application and reconciled saga, and the original provisional and consume ledger entries. It appends one `consumed_reversal` entry (informational: the debt
 * is not a balance), inserts exactly one recovery obligation keyed by the cause, raises the account's recovery_due, and marks the lot and decision reversed. The consumed
 * reservation, the application row and the `consume` entry are never edited: the billing history stays exactly as it was.
 */
async function compensateConsumed(tx: Transaction, decision: Decision, lot: Lot, input: Input): Promise<'recovery_obligation_created'> {
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
  await tx.insert(partnerCreditRecoveryObligations).values({ accountId: account.id, reversalRef: causeRef(input.cause), unitsDue: 1, unitsOutstanding: 1 });
  await tx.insert(partnerCreditLedger).values({
    accountId: account.id, decisionId: decision.id, entryType: 'consumed_reversal', units: 1, idempotencyKey: canonicalKey(decision),
    metadata: { settlementRef: decision.settlementRef, ...causeMeta(input.cause), reservationId: reservation.id, applicationId: application.id },
  });
  await tx.update(partnerCreditAccounts).set({ recoveryDue: sql`${partnerCreditAccounts.recoveryDue} + 1`, updatedAt: now }).where(eq(partnerCreditAccounts.id, account.id));
  await tx.update(partnerCreditLots).set({ status: 'reversed', availableUnits: 0 }).where(eq(partnerCreditLots.id, lot.id));
  await tx.update(partnerCreditAwardDecisions).set({ state: 'reversed' }).where(eq(partnerCreditAwardDecisions.id, decision.id));
  return 'recovery_obligation_created';
}

/**
 * R10 G2: the credit was consumed by a recovery-offset vest (no reservation): its vesting unit paid down an existing recovery obligation. Revoking it reinstates that exact
 * amount, on that exact obligation. The amount and the obligation come ONLY from the decision's own immutable `recovery_offset` ledger entry (at most one unit, one entry);
 * the restoration is one new `recovery_restored` entry (one per decision), the obligation's outstanding units and the account's recovery_due rise by the same amount, and
 * the lot and decision become reversed. If the offset cannot be proven, or the obligation or projection does not reconcile, it throws and nothing is written. A lot set to
 * `consumed` by hand with no offset entry keeps failing closed with the original error.
 */
async function restoreOffsetConsumed(tx: Transaction, decision: Decision, lot: Lot, input: Input): Promise<'recovery_restored'> {
  if (lot.units !== 1 || lot.availableUnits !== 0 || decision.awardUnits !== 1) throw new Error('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED');
  const entries = await tx.select().from(partnerCreditLedger).where(eq(partnerCreditLedger.decisionId, decision.id));
  const offsets = entries.filter(e => e.entryType === 'recovery_offset');
  if (offsets.length === 0) throw new Error('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED'); // no evidence at all: the original fail-closed behaviour
  if (offsets.length !== 1) throw new Error('PARTNER_REVERSAL_RESTORE_UNPROVABLE');
  if (entries.some(e => ['reverse', 'consumed_reversal', 'recovery_restored', 'reversal_noop', 'consume'].includes(e.entryType))) throw new Error('PARTNER_REVERSAL_ALREADY_COMPENSATED');
  const [account] = await tx.select().from(partnerCreditAccounts).where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
  if (!account || account.businessId !== input.businessId) throw new Error('PARTNER_REVERSAL_ACCOUNT_INCONSISTENT');

  const offset = offsets[0]!;
  const meta = (offset.metadata ?? {}) as { obligationId?: unknown; offsetUnits?: unknown };
  const units = -offset.units;
  if (offset.accountId !== account.id || typeof meta.obligationId !== 'string' || !Number.isSafeInteger(units) || units < 1 || meta.offsetUnits !== units)
    throw new Error('PARTNER_REVERSAL_RESTORE_UNPROVABLE');
  const provisional = entries.filter(e => e.entryType === 'provisional');
  if (provisional.length !== 1 || provisional[0]!.accountId !== account.id || provisional[0]!.units !== 1) throw new Error('PARTNER_REVERSAL_MISSING_ORIGINAL_LEDGER');

  // Same lock discipline as the vest offset: the account's obligations, ordered by creation then id.
  const obligations = await tx.select().from(partnerCreditRecoveryObligations)
    .where(eq(partnerCreditRecoveryObligations.accountId, account.id))
    .orderBy(asc(partnerCreditRecoveryObligations.createdAt), asc(partnerCreditRecoveryObligations.id)).for('update');
  const obligation = obligations.find(o => o.id === meta.obligationId);
  const outstanding = obligations.reduce((sum, o) => sum + o.unitsOutstanding, 0);
  if (!obligation || outstanding !== account.recoveryDue) throw new Error('PARTNER_REVERSAL_RESTORE_UNPROVABLE');
  if (obligation.unitsOutstanding + units > obligation.unitsDue) throw new Error('PARTNER_REVERSAL_RESTORE_UNPROVABLE');

  await tx.insert(partnerCreditLedger).values({
    accountId: account.id, decisionId: decision.id, entryType: 'recovery_restored', units, idempotencyKey: canonicalKey(decision),
    metadata: { settlementRef: decision.settlementRef, ...causeMeta(input.cause), obligationId: obligation.id, restoredUnits: units, offsetEntryId: offset.id },
  });
  await tx.update(partnerCreditRecoveryObligations).set({ unitsOutstanding: sql`${partnerCreditRecoveryObligations.unitsOutstanding} + ${units}` })
    .where(eq(partnerCreditRecoveryObligations.id, obligation.id));
  await tx.update(partnerCreditAccounts).set({ recoveryDue: sql`${partnerCreditAccounts.recoveryDue} + ${units}`, updatedAt: new Date() })
    .where(eq(partnerCreditAccounts.id, account.id));
  await tx.update(partnerCreditLots).set({ status: 'reversed', availableUnits: 0 }).where(eq(partnerCreditLots.id, lot.id));
  await tx.update(partnerCreditAwardDecisions).set({ state: 'reversed' }).where(eq(partnerCreditAwardDecisions.id, decision.id));
  return 'recovery_restored';
}

/**
 * R10 G1: an EXPIRED credit has no balance left to reverse. It closes with one informational `reversal_noop` entry (the ledger forbids a zero-unit entry), the lot
 * and decision become reversed, and no bucket moves. Only when nothing else ever happened to the credit: exactly one provisional, one vest and one expire entry, no
 * other ledger entry, and no reservation (so no application or saga intent can exist). Otherwise it throws and nothing is written.
 */
async function closeExpired(tx: Transaction, decision: Decision, lot: Lot, input: Input): Promise<'closed_no_effect'> {
  if (lot.units !== 1 || lot.availableUnits !== 0 || decision.awardUnits !== 1) throw new Error('PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED');
  const [account] = await tx.select().from(partnerCreditAccounts).where(eq(partnerCreditAccounts.id, lot.accountId)).for('update');
  if (!account || account.businessId !== input.businessId) throw new Error('PARTNER_REVERSAL_ACCOUNT_INCONSISTENT');
  const entries = await tx.select().from(partnerCreditLedger).where(eq(partnerCreditLedger.decisionId, decision.id));
  const count = (t: string) => entries.filter(e => e.entryType === t).length;
  if (entries.length !== 3 || count('provisional') !== 1 || count('vest') !== 1 || count('expire') !== 1 || entries.some(e => e.accountId !== account.id))
    throw new Error('PARTNER_REVERSAL_CLOSE_NOT_PROVABLE');
  const [reservation] = await tx.select({ id: partnerCreditReservations.id }).from(partnerCreditReservations)
    .where(eq(partnerCreditReservations.decisionId, decision.id)).limit(1);
  if (reservation) throw new Error('PARTNER_REVERSAL_CLOSE_NOT_PROVABLE');

  await tx.insert(partnerCreditLedger).values({
    accountId: account.id, decisionId: decision.id, entryType: 'reversal_noop', units: 1, idempotencyKey: canonicalKey(decision),
    metadata: { settlementRef: decision.settlementRef, ...causeMeta(input.cause) },
  });
  await tx.update(partnerCreditLots).set({ status: 'reversed', availableUnits: 0 }).where(eq(partnerCreditLots.id, lot.id));
  await tx.update(partnerCreditAwardDecisions).set({ state: 'reversed' }).where(eq(partnerCreditAwardDecisions.id, decision.id));
  return 'closed_no_effect';
}
