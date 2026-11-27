import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  applyMilestone,
  applyMissions,
  applyStreak,
  milestoneStateFrom,
  missionStateFrom,
  streakStateFrom,
  type EngineOutcome,
  type ProgressEvent,
} from '@echo-grid-feedback/shared-types';
import type { Database } from '../../db/client';
import { loyaltyProgramEntitlements, loyaltyProgramProgress, loyaltyProgramProgressEvents, loyaltyRewards } from '../../db/schema';
import { AppError } from '../../lib/errors';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ProgressInput {
  businessId: string;
  programId: string;
  programVersion: number;
  type: 'LP-04' | 'LP-05' | 'LP-07';
  config: Record<string, unknown>;
  loyaltyAccountId: string;
  customerId: string;
  /** Deterministic key of the verified event: `purchase:<purchase event id>` or `checkin:<ledger transaction id>`. A replay of it is a no-op. */
  eventKey: string;
  purchaseEventId?: string | undefined;
  event: ProgressEvent;
  /** The business IANA timezone: streak periods are business-local days and weeks, never the database UTC day. */
  timeZone: string;
}

export interface ProgressResult {
  applied: boolean;
  grantedEntitlements: number;
  reason?: string | undefined;
}

/**
 * Runs INSIDE the earning transaction for LP-04 (milestones), LP-05 (streaks) and LP-07 (missions). The customer's progress row is locked for the
 * rest of the transaction, so racing events cannot both read the same counters; the verified event is applied once (its marker row is unique per
 * programme), every step is appended to the progress history, and each reward is granted at most once through a unique entitlement key.
 */
export async function recordProgrammeProgress(tx: Tx, input: ProgressInput): Promise<ProgressResult> {
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
  if (progress.frozenAt) return { applied: false, grantedEntitlements: 0, reason: 'FROZEN' };

  const marker = `${input.eventKey}:applied`;
  const [seen] = await tx
    .select({ id: loyaltyProgramProgressEvents.id })
    .from(loyaltyProgramProgressEvents)
    .where(and(eq(loyaltyProgramProgressEvents.programId, input.programId), eq(loyaltyProgramProgressEvents.sourceKey, marker)))
    .limit(1);
  if (seen) return { applied: false, grantedEntitlements: 0, reason: 'DUPLICATE_EVENT' };

  const counters = progress.counters;
  let outcome: EngineOutcome<object>;
  if (input.type === 'LP-04') outcome = applyMilestone(input.config, milestoneStateFrom(counters), input.event);
  else if (input.type === 'LP-05') outcome = applyStreak(input.config, streakStateFrom(counters), input.event, input.timeZone);
  else outcome = applyMissions(input.config, missionStateFrom(counters), input.event);
  if (outcome.steps.length === 0) return { applied: false, grantedEntitlements: 0, reason: outcome.reason };

  const after = { ...outcome.state } as Record<string, unknown>;
  const record = async (kind: string, delta: number, key: string) => {
    await tx.insert(loyaltyProgramProgressEvents).values({
      progressId: progress.id,
      businessId: input.businessId,
      programId: input.programId,
      programVersion: input.programVersion,
      loyaltyAccountId: input.loyaltyAccountId,
      kind,
      delta: Math.max(Math.min(Math.trunc(delta), 2_147_483_647), -2_147_483_648),
      countersAfter: after,
      purchaseEventId: input.purchaseEventId ?? null,
      sourceKey: key,
    });
  };
  await record('applied', 0, marker);
  let index = 0;
  for (const step of outcome.steps) {
    await record(step.kind.split(':')[0] as string, step.delta, `${input.eventKey}:${index}:${step.kind}`);
    index += 1;
  }
  let granted = 0;
  for (const grant of outcome.grants) {
    const rows = await tx
      .insert(loyaltyProgramEntitlements)
      .values({
        businessId: input.businessId,
        programId: input.programId,
        programVersion: input.programVersion,
        loyaltyAccountId: input.loyaltyAccountId,
        rewardId: grant.rewardId,
        sourceKey: grant.key,
      })
      .onConflictDoNothing({ target: [loyaltyProgramEntitlements.programId, loyaltyProgramEntitlements.loyaltyAccountId, loyaltyProgramEntitlements.sourceKey] })
      .returning({ id: loyaltyProgramEntitlements.id });
    granted += rows.length;
  }
  await tx.update(loyaltyProgramProgress).set({ counters: after, updatedAt: sql`now()` }).where(eq(loyaltyProgramProgress.id, progress.id));
  return { applied: true, grantedEntitlements: granted };
}

/** Looks up the rewards a configuration points at, for validation: they must exist in THIS business, be active and be of an allowed type. */
export async function loadRewardsForValidation(tx: Pick<Database, 'select'>, businessId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({ id: loyaltyRewards.id, type: loyaltyRewards.type, status: loyaltyRewards.status })
    .from(loyaltyRewards)
    .where(and(inArray(loyaltyRewards.id, ids), eq(loyaltyRewards.businessId, businessId), eq(loyaltyRewards.isDeleted, false)));
}
