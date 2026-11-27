import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { loyaltyAccounts, loyaltyProgramEntitlements, loyaltyRewards } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { consumeEntitlement } from './stamp.service';

export interface AvailableEntitlement {
  id: string;
  rewardId: string;
  rewardName: string;
  rewardType: string;
  earnedAt: Date;
  expiresAt: Date | null;
}

/** The account must belong to this business and not be suspended; anything else is a uniform 404 (no cross-tenant probing). */
async function requireServableAccount(db: Database, businessId: string, accountId: string) {
  const [account] = await db
    .select({ id: loyaltyAccounts.id, status: loyaltyAccounts.status })
    .from(loyaltyAccounts)
    .where(and(eq(loyaltyAccounts.id, accountId), eq(loyaltyAccounts.businessId, businessId)))
    .limit(1);
  if (!account) throw new AppError('Loyalty account not found.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
  return account;
}

/** Earned, unused, unexpired programme rewards a cashier can hand over for this account. Branch-limited rewards show only at their branch. */
export async function listAvailableEntitlements(
  db: Database,
  input: { businessId: string; accountId: string; branchId?: string | undefined },
): Promise<AvailableEntitlement[]> {
  await requireServableAccount(db, input.businessId, input.accountId);
  return db
    .select({
      id: loyaltyProgramEntitlements.id,
      rewardId: loyaltyProgramEntitlements.rewardId,
      rewardName: loyaltyRewards.name,
      rewardType: loyaltyRewards.type,
      earnedAt: loyaltyProgramEntitlements.earnedAt,
      expiresAt: loyaltyProgramEntitlements.expiresAt,
    })
    .from(loyaltyProgramEntitlements)
    .innerJoin(loyaltyRewards, eq(loyaltyRewards.id, loyaltyProgramEntitlements.rewardId))
    .where(
      and(
        eq(loyaltyProgramEntitlements.businessId, input.businessId),
        eq(loyaltyProgramEntitlements.loyaltyAccountId, input.accountId),
        eq(loyaltyProgramEntitlements.status, 'available'),
        sql`(${loyaltyProgramEntitlements.expiresAt} IS NULL OR ${loyaltyProgramEntitlements.expiresAt} > now())`,
        input.branchId
          ? sql`(${loyaltyRewards.branchId} IS NULL OR ${loyaltyRewards.branchId} = ${input.branchId})`
          : sql`true`,
      ),
    )
    .orderBy(asc(loyaltyProgramEntitlements.earnedAt), asc(loyaltyProgramEntitlements.id));
}

/**
 * A cashier hands over one earned reward. Single use (atomic conditional update), scoped to this business AND this
 * account, refused for a suspended account or a reward limited to another branch. Never changes the programme.
 */
export async function redeemAccountEntitlement(
  db: Database,
  input: { businessId: string; accountId: string; entitlementId: string; redeemedBy: string; branchId?: string | undefined },
) {
  const account = await requireServableAccount(db, input.businessId, input.accountId);
  if (account.status === 'suspended') throw new AppError('This loyalty account is suspended.', 409, 'LOYALTY_ACCOUNT_SUSPENDED');
  if (input.branchId) {
    const [row] = await db
      .select({ branchId: loyaltyRewards.branchId })
      .from(loyaltyProgramEntitlements)
      .innerJoin(loyaltyRewards, eq(loyaltyRewards.id, loyaltyProgramEntitlements.rewardId))
      .where(and(eq(loyaltyProgramEntitlements.id, input.entitlementId), eq(loyaltyProgramEntitlements.loyaltyAccountId, input.accountId)))
      .limit(1);
    if (row?.branchId && row.branchId !== input.branchId) {
      throw new AppError('This reward is not available at this branch.', 409, 'ENTITLEMENT_NOT_AVAILABLE');
    }
  }
  return consumeEntitlement(db, {
    businessId: input.businessId,
    entitlementId: input.entitlementId,
    redeemedBy: input.redeemedBy,
    loyaltyAccountId: input.accountId,
  });
}
