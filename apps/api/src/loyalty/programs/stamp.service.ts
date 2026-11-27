import { and, eq, sql } from 'drizzle-orm';
import { applyStamp, stampStateFrom, type PurchaseFact } from '@echo-grid-feedback/shared-types';
import type { Database } from '../../db/client';
import { loyaltyProgramEntitlements, loyaltyProgramProgress, loyaltyProgramProgressEvents } from '../../db/schema';
import { AppError } from '../../lib/errors';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface StampResult {
  stamped: boolean;
  stamps: number;
  expiredStamps: number;
  completedCycle: number | null;
  entitlementId: string | null;
}

/**
 * LP-01 stamp engine, run INSIDE the purchase transaction. One stamp per verified purchase event (the source key is the purchase event id, and the
 * unique index makes a replay a no-op), applied under a row lock on the customer's progress so concurrent receipts cannot both read the same count.
 * Completing a card creates ONE single-use entitlement for the configured free-item reward and restarts the card.
 */
export async function recordPurchaseStamp(
  tx: Tx,
  input: {
    businessId: string;
    programId: string;
    programVersion: number;
    config: Record<string, unknown>;
    loyaltyAccountId: string;
    customerId: string;
    purchaseEventId: string;
    occurredAt: Date;
    fact: PurchaseFact;
  },
): Promise<StampResult> {
  // Make sure the progress row exists, then lock it for the rest of this transaction.
  await tx
    .insert(loyaltyProgramProgress)
    .values({ businessId: input.businessId, programId: input.programId, loyaltyAccountId: input.loyaltyAccountId, customerId: input.customerId, counters: {} })
    .onConflictDoNothing({ target: [loyaltyProgramProgress.programId, loyaltyProgramProgress.loyaltyAccountId] });
  const [progress] = await tx
    .select()
    .from(loyaltyProgramProgress)
    .where(and(eq(loyaltyProgramProgress.programId, input.programId), eq(loyaltyProgramProgress.loyaltyAccountId, input.loyaltyAccountId)))
    .for('update');
  if (!progress) throw new AppError('Programme progress could not be opened.', 500, 'PROGRAM_PROGRESS_UNAVAILABLE');

  const sourceKey = `purchase:${input.purchaseEventId}`;
  const [existing] = await tx
    .select({ id: loyaltyProgramProgressEvents.id })
    .from(loyaltyProgramProgressEvents)
    .where(and(eq(loyaltyProgramProgressEvents.programId, input.programId), eq(loyaltyProgramProgressEvents.sourceKey, `${sourceKey}:stamp`)))
    .limit(1);
  const current = stampStateFrom(progress.counters);
  if (existing) return { stamped: false, stamps: current.stamps, expiredStamps: 0, completedCycle: null, entitlementId: null };

  const outcome = applyStamp(input.config, current, { ...input.fact, now: input.occurredAt });
  if (!outcome.stamped) return { stamped: false, stamps: current.stamps, expiredStamps: 0, completedCycle: null, entitlementId: null };

  const record = async (kind: string, delta: number, key: string, countersAfter: Record<string, unknown>) => {
    await tx.insert(loyaltyProgramProgressEvents).values({
      progressId: progress.id,
      businessId: input.businessId,
      programId: input.programId,
      programVersion: input.programVersion,
      loyaltyAccountId: input.loyaltyAccountId,
      kind,
      delta,
      countersAfter,
      purchaseEventId: input.purchaseEventId,
      sourceKey: key,
    });
  };
  if (outcome.expiredStamps > 0) {
    await record('expired', -outcome.expiredStamps, `${sourceKey}:expired`, { stamps: 0, cycle: current.cycle, cycleStartedAt: null });
  }
  await record('stamp', 1, `${sourceKey}:stamp`, { ...outcome.state });

  let entitlementId: string | null = null;
  if (outcome.completedCycle !== null) {
    const [entitlement] = await tx
      .insert(loyaltyProgramEntitlements)
      .values({
        businessId: input.businessId,
        programId: input.programId,
        programVersion: input.programVersion,
        loyaltyAccountId: input.loyaltyAccountId,
        rewardId: String(input.config.rewardId),
        sourceKey: `cycle:${outcome.completedCycle}`,
      })
      .onConflictDoNothing({ target: [loyaltyProgramEntitlements.programId, loyaltyProgramEntitlements.loyaltyAccountId, loyaltyProgramEntitlements.sourceKey] })
      .returning({ id: loyaltyProgramEntitlements.id });
    entitlementId = entitlement?.id ?? null;
    await record('cycle_completed', 0, `${sourceKey}:complete`, { ...outcome.state });
  }
  await tx.update(loyaltyProgramProgress).set({ counters: { ...outcome.state }, updatedAt: sql`now()` }).where(eq(loyaltyProgramProgress.id, progress.id));
  return { stamped: true, stamps: outcome.state.stamps, expiredStamps: outcome.expiredStamps, completedCycle: outcome.completedCycle, entitlementId };
}

/** Atomically uses an earned entitlement: it can be redeemed once, by this business only, and never after it has been used, expired or reversed. */
export async function consumeEntitlement(
  db: Database,
  input: { businessId: string; entitlementId: string; redeemedBy: string; loyaltyAccountId?: string },
): Promise<{ id: string; rewardId: string; loyaltyAccountId: string }> {
  const [row] = await db
    .update(loyaltyProgramEntitlements)
    .set({ status: 'redeemed', redeemedAt: new Date(), redeemedBy: input.redeemedBy })
    .where(
      and(
        eq(loyaltyProgramEntitlements.id, input.entitlementId),
        eq(loyaltyProgramEntitlements.businessId, input.businessId),
        eq(loyaltyProgramEntitlements.status, 'available'),
        ...(input.loyaltyAccountId ? [eq(loyaltyProgramEntitlements.loyaltyAccountId, input.loyaltyAccountId)] : []),
        sql`(${loyaltyProgramEntitlements.expiresAt} IS NULL OR ${loyaltyProgramEntitlements.expiresAt} > now())`,
      ),
    )
    .returning({ id: loyaltyProgramEntitlements.id, rewardId: loyaltyProgramEntitlements.rewardId, loyaltyAccountId: loyaltyProgramEntitlements.loyaltyAccountId });
  if (!row) throw new AppError('This reward is not available.', 409, 'ENTITLEMENT_NOT_AVAILABLE');
  return row;
}
