import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { minorFromStored, type LoyaltyProgramType, type ProgressEvent } from '@echo-grid-feedback/shared-types';
import type { Database } from '../../db/client';
import {
  loyaltyProgramEntitlements,
  loyaltyProgramProgress,
  loyaltyProgramProgressEvents,
  loyaltyProgramVersions,
  loyaltyPrograms,
  loyaltyRewards,
  loyaltyPurchaseEvents,
  loyaltyTransactions,
} from '../../db/schema';
import { AppError } from '../../lib/errors';
import { replayProgress, sameCounters, type ReplayStep } from './progress-replay';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ProgressReversalResult {
  programmesAdjusted: number;
  revokedEntitlements: number;
  /** Entitlements the history no longer supports but that were ALREADY handed over: kept, and flagged for the Owner to review. */
  usedEntitlementIds: string[];
  /** What the reversal does to each affected reward, by catalogue name, for the Owner's confirmation screen. */
  rewardImpact: { rewardName: string; outcome: 'revoked' | 'already_used' }[];
  /** Programmes whose progress is frozen (switched away): their counters never change, so nothing was adjusted there. */
  frozenProgrammes: number;
}

/**
 * LPC-08: takes one purchase's effect out of a customer's programme progress. For every programme that applied this purchase, the progress is
 * derived again from the recorded history without it (same engines as live earning), rewards the history no longer supports are revoked if still
 * unused, and an unused-reward that was already handed over is left alone and reported. Safety: the history must first reproduce the stored
 * counters exactly; if it does not, nothing is changed and the reversal is refused.
 * Runs INSIDE the reversal transaction, after the purchase event was marked reversed and the account row was locked.
 */
export async function reversePurchaseProgress(
  tx: Tx,
  input: { businessId: string; loyaltyAccountId: string; purchaseEventId: string; timeZone: string; currency: string },
): Promise<ProgressReversalResult> {
  const result: ProgressReversalResult = { programmesAdjusted: 0, revokedEntitlements: 0, usedEntitlementIds: [], rewardImpact: [], frozenProgrammes: 0 };
  const touched = await tx
    .selectDistinct({ programId: loyaltyProgramProgressEvents.programId })
    .from(loyaltyProgramProgressEvents)
    .where(and(eq(loyaltyProgramProgressEvents.loyaltyAccountId, input.loyaltyAccountId), eq(loyaltyProgramProgressEvents.purchaseEventId, input.purchaseEventId)));

  for (const { programId } of touched) {
    const [progress] = await tx
      .select()
      .from(loyaltyProgramProgress)
      .where(and(eq(loyaltyProgramProgress.programId, programId), eq(loyaltyProgramProgress.loyaltyAccountId, input.loyaltyAccountId)))
      .for('update');
    if (!progress) continue;
    if (progress.frozenAt) {
      result.frozenProgrammes += 1;
      continue;
    }
    const [programme] = await tx.select({ type: loyaltyPrograms.type }).from(loyaltyPrograms).where(and(eq(loyaltyPrograms.id, programId), eq(loyaltyPrograms.businessId, input.businessId))).limit(1);
    if (!programme) continue;
    const type = programme.type as LoyaltyProgramType;

    const versions = new Map<number, Record<string, unknown>>();
    for (const v of await tx.select({ version: loyaltyProgramVersions.version, config: loyaltyProgramVersions.config }).from(loyaltyProgramVersions).where(eq(loyaltyProgramVersions.programId, programId))) {
      versions.set(v.version, v.config);
    }
    // The events that were applied, in the order they were applied: LP-01 records a `stamp` row, the others an `applied` marker.
    const markers = await tx
      .select()
      .from(loyaltyProgramProgressEvents)
      .where(and(
        eq(loyaltyProgramProgressEvents.programId, programId),
        eq(loyaltyProgramProgressEvents.loyaltyAccountId, input.loyaltyAccountId),
        or(eq(loyaltyProgramProgressEvents.kind, 'stamp'), eq(loyaltyProgramProgressEvents.kind, 'applied')),
      ))
      .orderBy(asc(loyaltyProgramProgressEvents.createdAt), asc(loyaltyProgramProgressEvents.id));

    const purchaseIds = markers.map((m) => m.purchaseEventId).filter((id): id is string => id !== null);
    const purchases = new Map<string, { amount: string; occurredAt: Date; status: string }>();
    if (purchaseIds.length > 0) {
      for (const p of await tx
        .select({ id: loyaltyPurchaseEvents.id, amount: loyaltyPurchaseEvents.qualifyingAmount, occurredAt: loyaltyPurchaseEvents.occurredAt, status: loyaltyPurchaseEvents.paymentStatus })
        .from(loyaltyPurchaseEvents)
        .where(inArray(loyaltyPurchaseEvents.id, purchaseIds))) {
        purchases.set(p.id, { amount: p.amount, occurredAt: p.occurredAt, status: p.status });
      }
    }
    const checkinIds = markers.filter((m) => m.sourceKey.startsWith('checkin:')).map((m) => m.sourceKey.split(':')[1]!);
    const checkins = new Map<string, Date>();
    if (checkinIds.length > 0) {
      for (const c of await tx.select({ id: loyaltyTransactions.id, createdAt: loyaltyTransactions.createdAt }).from(loyaltyTransactions).where(inArray(loyaltyTransactions.id, checkinIds))) {
        checkins.set(c.id, c.createdAt);
      }
    }

    const withoutEarlier: ReplayStep[] = [];
    const withoutThis: ReplayStep[] = [];
    let targetMarkerId: string | null = null;
    for (const marker of markers) {
      const config = versions.get(marker.programVersion);
      if (!config) throw new AppError('This purchase’s programme history is incomplete, so it cannot be reversed safely.', 409, 'PROGRESS_REPLAY_MISMATCH');
      let event: ProgressEvent;
      let earlierReversal = false;
      if (marker.purchaseEventId) {
        const purchase = purchases.get(marker.purchaseEventId);
        if (!purchase) throw new AppError('This purchase’s programme history is incomplete, so it cannot be reversed safely.', 409, 'PROGRESS_REPLAY_MISMATCH');
        event = { kind: 'purchase', amountMinor: minorFromStored(purchase.amount, input.currency), currency: input.currency, occurredAt: purchase.occurredAt };
        earlierReversal = purchase.status !== 'confirmed' && marker.purchaseEventId !== input.purchaseEventId;
      } else {
        const at = checkins.get(marker.sourceKey.split(':')[1]!);
        if (!at) throw new AppError('This purchase’s programme history is incomplete, so it cannot be reversed safely.', 409, 'PROGRESS_REPLAY_MISMATCH');
        event = { kind: 'visit', occurredAt: at };
      }
      if (earlierReversal) continue; // counters already exclude events reversed before this one
      const step: ReplayStep = { config, event };
      withoutEarlier.push(step);
      if (marker.purchaseEventId === input.purchaseEventId) targetMarkerId = marker.id;
      else withoutThis.push(step);
    }

    // The history must reproduce what is stored today, otherwise the reversal is refused rather than guessed.
    const current = replayProgress(type, withoutEarlier, input.timeZone);
    if (!sameCounters(current.counters, progress.counters)) {
      throw new AppError('This customer’s programme progress cannot be reproduced from its history, so the purchase cannot be reversed automatically. Adjust points manually instead.', 409, 'PROGRESS_REPLAY_MISMATCH');
    }
    const next = replayProgress(type, withoutThis, input.timeZone);

    const entitlements = await tx
      .select({ id: loyaltyProgramEntitlements.id, sourceKey: loyaltyProgramEntitlements.sourceKey, status: loyaltyProgramEntitlements.status, rewardName: loyaltyRewards.name })
      .from(loyaltyProgramEntitlements)
      .innerJoin(loyaltyRewards, eq(loyaltyRewards.id, loyaltyProgramEntitlements.rewardId))
      .where(and(eq(loyaltyProgramEntitlements.programId, programId), eq(loyaltyProgramEntitlements.loyaltyAccountId, input.loyaltyAccountId)));
    for (const entitlement of entitlements) {
      if (next.grants.has(entitlement.sourceKey)) continue;
      if (entitlement.status === 'available') {
        // LPC-15: the revocation counts only what the database really changed. A hand-over that commits between the read above and this update leaves
        // zero rows to revoke; the reward is then reported as already used (flagged for review) instead of as revoked.
        const revoked = await tx
          .update(loyaltyProgramEntitlements)
          .set({ status: 'reversed' })
          .where(and(eq(loyaltyProgramEntitlements.id, entitlement.id), eq(loyaltyProgramEntitlements.status, 'available')))
          .returning({ id: loyaltyProgramEntitlements.id });
        if (revoked.length > 0) {
          result.revokedEntitlements += 1;
          result.rewardImpact.push({ rewardName: entitlement.rewardName, outcome: 'revoked' });
        } else {
          const [current] = await tx.select({ status: loyaltyProgramEntitlements.status }).from(loyaltyProgramEntitlements).where(eq(loyaltyProgramEntitlements.id, entitlement.id)).limit(1);
          if (current?.status === 'redeemed') {
            result.usedEntitlementIds.push(entitlement.id);
            result.rewardImpact.push({ rewardName: entitlement.rewardName, outcome: 'already_used' });
          }
        }
      } else if (entitlement.status === 'redeemed') {
        result.usedEntitlementIds.push(entitlement.id);
        result.rewardImpact.push({ rewardName: entitlement.rewardName, outcome: 'already_used' });
      }
    }

    const target = markers.find((m) => m.id === targetMarkerId);
    await tx.insert(loyaltyProgramProgressEvents).values({
      progressId: progress.id,
      businessId: input.businessId,
      programId,
      programVersion: target?.programVersion ?? 1,
      loyaltyAccountId: input.loyaltyAccountId,
      kind: 'reversed',
      delta: 0,
      countersAfter: next.counters,
      purchaseEventId: input.purchaseEventId,
      sourceKey: `reverse:${input.purchaseEventId}`,
      reversesEventId: target?.id ?? null,
    });
    await tx.update(loyaltyProgramProgress).set({ counters: next.counters, updatedAt: sql`now()` }).where(eq(loyaltyProgramProgress.id, progress.id));
    result.programmesAdjusted += 1;
  }
  return result;
}
