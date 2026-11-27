import { and, eq, inArray } from 'drizzle-orm';
import { programmeCardView, type ProgrammeCardView } from '@echo-grid-feedback/shared-types';
import type { Database } from '../../db/client';
import { businesses, loyaltyAccounts, loyaltyProgramProgress, loyaltyRewards } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { listAvailableEntitlements } from './entitlement.service';
import { resolveActiveProgramme } from './program.service';

export interface CustomerProgrammeCard {
  currency: string;
  /** null when the business earns under its original points settings, or has no active programme. */
  programme: { type: string; view: ProgrammeCardView; rewardNames: Record<string, string> } | null;
  /** Rewards this customer has earned and not yet received: names and expiry only, never an entitlement id. */
  earnedRewards: { rewardName: string; expiresAt: Date | null }[];
}

/**
 * LPC-07: what a customer sees about the business's active programme: their own progress and the programme's public terms. Identity comes from the
 * authenticated session (never a parameter); the account must be this customer's own at this business.
 */
export async function customerProgrammeCard(db: Database, input: { customerId: string; businessId: string; now?: Date }): Promise<CustomerProgrammeCard> {
  const [account] = await db
    .select({ id: loyaltyAccounts.id })
    .from(loyaltyAccounts)
    .where(and(eq(loyaltyAccounts.customerId, input.customerId), eq(loyaltyAccounts.businessId, input.businessId)))
    .limit(1);
  if (!account) throw new AppError('You are not enrolled in this loyalty program yet.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');

  const [business] = await db.select({ currency: businesses.defaultCurrency }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
  const currency = business?.currency ?? 'USD';
  const earned = await listAvailableEntitlements(db, { businessId: input.businessId, accountId: account.id });
  const earnedRewards = earned.map((e) => ({ rewardName: e.rewardName, expiresAt: e.expiresAt }));

  const resolved = await resolveActiveProgramme(db, input.businessId);
  if (resolved.kind !== 'programme') return { currency, programme: null, earnedRewards };

  const [progress] = await db
    .select({ counters: loyaltyProgramProgress.counters, frozenAt: loyaltyProgramProgress.frozenAt })
    .from(loyaltyProgramProgress)
    .where(and(eq(loyaltyProgramProgress.programId, resolved.programId), eq(loyaltyProgramProgress.loyaltyAccountId, account.id)))
    .limit(1);
  const view = programmeCardView(resolved.type, resolved.config, progress?.frozenAt ? {} : progress?.counters, currency, input.now ?? new Date());
  if (!view) return { currency, programme: null, earnedRewards };

  const ids = rewardIdsOf(view);
  const rows = ids.length
    ? await db.select({ id: loyaltyRewards.id, name: loyaltyRewards.name }).from(loyaltyRewards).where(and(eq(loyaltyRewards.businessId, input.businessId), inArray(loyaltyRewards.id, ids)))
    : [];
  return { currency, programme: { type: resolved.type, view, rewardNames: Object.fromEntries(rows.map((r) => [r.id, r.name])) }, earnedRewards };
}

function rewardIdsOf(view: ProgrammeCardView): string[] {
  switch (view.kind) {
    case 'stamps':
    case 'streak':
      return [view.rewardId];
    case 'milestones':
      return view.ladder.map((m) => m.rewardId);
    case 'missions':
      return view.missions.map((m) => m.rewardId);
    default:
      return [];
  }
}
