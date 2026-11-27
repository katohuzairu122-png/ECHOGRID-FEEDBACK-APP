import { and, eq, sql } from 'drizzle-orm';
import { programRewardIds } from '@echo-grid-feedback/shared-types';
import type { Database } from '../../db/client';
import { loyaltyProgramEntitlements, loyaltyProgramVersions, loyaltyPrograms } from '../../db/schema';
import { AppError } from '../../lib/errors';

export interface RewardUsage {
  /** Active programmes whose current configuration pays out this reward. */
  activeProgrammes: { id: string; type: string }[];
  /** Earned rewards of this catalogue item that customers are still waiting to receive. */
  waitingEntitlements: number;
}

/** Where a catalogue reward is in use right now: by the business's active programme, and by customers' earned-but-unused rewards. */
export async function findRewardUsage(db: Database, businessId: string, rewardId: string): Promise<RewardUsage> {
  const active = await db
    .select({ id: loyaltyPrograms.id, type: loyaltyPrograms.type, config: loyaltyProgramVersions.config })
    .from(loyaltyPrograms)
    .innerJoin(loyaltyProgramVersions, and(eq(loyaltyProgramVersions.programId, loyaltyPrograms.id), eq(loyaltyProgramVersions.version, loyaltyPrograms.currentVersion)))
    .where(and(eq(loyaltyPrograms.businessId, businessId), eq(loyaltyPrograms.status, 'active')));
  const activeProgrammes = active.filter((p) => programRewardIds(p.type, p.config).includes(rewardId)).map((p) => ({ id: p.id, type: p.type }));
  const [waiting] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loyaltyProgramEntitlements)
    .where(and(eq(loyaltyProgramEntitlements.businessId, businessId), eq(loyaltyProgramEntitlements.rewardId, rewardId), eq(loyaltyProgramEntitlements.status, 'available')));
  return { activeProgrammes, waitingEntitlements: waiting?.count ?? 0 };
}

/**
 * LPC-09: a catalogue reward the active programme pays out cannot be switched off or deleted from under it, and a reward customers have earned
 * but not yet received cannot be deleted. The Owner first changes the programme (or the customers receive their rewards). Switching a reward off
 * is allowed while only waiting entitlements exist (they can still be handed over).
 */
export async function assertRewardCanChange(
  db: Database,
  input: { businessId: string; rewardId: string; change: 'deactivate' | 'remove' },
): Promise<void> {
  const usage = await findRewardUsage(db, input.businessId, input.rewardId);
  if (usage.activeProgrammes.length > 0) {
    throw new AppError(
      `This reward is paid out by your active loyalty programme (${usage.activeProgrammes.map((p) => p.type).join(', ')}). Change the programme first.`,
      409,
      'REWARD_IN_USE_BY_PROGRAMME',
    );
  }
  if (input.change === 'remove' && usage.waitingEntitlements > 0) {
    throw new AppError(
      `${usage.waitingEntitlements} customer(s) have earned this reward and have not received it yet. Hand it over before deleting it.`,
      409,
      'REWARD_HAS_WAITING_ENTITLEMENTS',
    );
  }
}
