import { eq, and, desc, isNull, or, sql } from 'drizzle-orm';
import { loyaltyTransactions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type LoyaltyTransaction = typeof loyaltyTransactions.$inferSelect;
export type NewLoyaltyTransaction = typeof loyaltyTransactions.$inferInsert;

export class LoyaltyTransactionRepository extends BaseRepository {
  async create(input: NewLoyaltyTransaction): Promise<LoyaltyTransaction> {
    const [row] = await this.db.insert(loyaltyTransactions).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async listForAccount(
    loyaltyAccountId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<LoyaltyTransaction[]> {
    return this.db.query.loyaltyTransactions.findMany({
      where: eq(loyaltyTransactions.loyaltyAccountId, loyaltyAccountId),
      limit: options.limit,
      offset: options.offset,
      orderBy: desc(loyaltyTransactions.createdAt),
    });
  }

  /** Looks up an in-flight redemption by the code staff verifies at the
   * counter -- confirmedAt filter distinguishes "pending" from "already
   * confirmed" without a separate status column (Block 4 uses this). */
  async findByRedemptionCode(code: string): Promise<LoyaltyTransaction | undefined> {
    return this.db.query.loyaltyTransactions.findFirst({
      where: eq(loyaltyTransactions.redemptionCode, code),
    });
  }

  /** WHERE guards on `redemptionConfirmedAt IS NULL` so this is the actual
   * source of truth for "did THIS call win the confirmation," not a
   * check-then-act race against a value read earlier -- two concurrent
   * confirms of the same code must not both succeed and hand out the reward
   * twice. Returns undefined for "already confirmed" exactly the same as
   * "doesn't exist"; the caller (LoyaltyRedemptionService.confirmRedemption)
   * has already ruled out "doesn't exist" via a preceding lookup, so it
   * attributes undefined here to a lost race.
   *
   * Continuing Development Block 6.2 (S6.7): also advances issuanceStatus
   * 'issued' -> 'redeemed' for a campaign-type row, atomically, in the same
   * guarded update -- not a second query, which would reopen the exact race
   * this method exists to close. The added WHERE clause
   * (`issuanceStatus IS NULL OR issuanceStatus = 'issued'`) is a no-op for
   * every points-type row (issuanceStatus is always NULL there, same as
   * before this block); the CASE expression in SET leaves NULL as NULL for
   * those rows, so this is 100% behavior-preserving for the existing flow. */
  async confirmRedemption(id: string): Promise<LoyaltyTransaction | undefined> {
    const [row] = await this.db
      .update(loyaltyTransactions)
      .set({
        redemptionConfirmedAt: new Date(),
        issuanceStatus: sql`CASE WHEN ${loyaltyTransactions.issuanceStatus} = 'issued' THEN 'redeemed' ELSE ${loyaltyTransactions.issuanceStatus} END`,
      })
      .where(
        and(
          eq(loyaltyTransactions.id, id),
          isNull(loyaltyTransactions.redemptionConfirmedAt),
          or(isNull(loyaltyTransactions.issuanceStatus), eq(loyaltyTransactions.issuanceStatus, 'issued')),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Continuing Development Block 5.2 (S5.7). Pre-check half of an explicit
   * find-then-create dedup, called from LoyaltyAccountService.recordCheckin
   * before it ever opens a ledger row -- deliberately NOT
   * `onConflictDoNothing` against loyalty_transactions_checkin_visit_key.
   * Drizzle's support for targeting a partial (WHERE-scoped) unique index
   * from the insert builder has multiple open, version-dependent upstream
   * bug reports, and this code has no way to be executed against a real
   * Postgres instance before shipping -- same reasoning, same conclusion, as
   * notification-preference.repository.ts's setPreference.
   *
   * The real backstop against a double reward under a genuinely concurrent
   * race is the partial unique index itself, not this check -- a raced
   * second insert still fails at the database; it just surfaces as a raw
   * constraint error instead of this graceful early return. Accepted for
   * the same reason notification preferences accepts it: the realistic
   * trigger here is a sequential retry or replay (S5.7's actual concern --
   * "refreshes, retries, repeated calls... must never create another
   * reward"), not two devices scanning the same shared table code in the
   * same millisecond.
   */
  async findCheckinByVisitSession(
    loyaltyAccountId: string,
    visitSessionId: string,
  ): Promise<LoyaltyTransaction | undefined> {
    return this.db.query.loyaltyTransactions.findFirst({
      where: and(
        eq(loyaltyTransactions.loyaltyAccountId, loyaltyAccountId),
        eq(loyaltyTransactions.visitSessionId, visitSessionId),
        eq(loyaltyTransactions.type, 'checkin'),
      ),
    });
  }

  /** Continuing Development Block 6.4 (S5.8 + S6.8 atomic limit
   * enforcement -- "maximum rewards per day" and "maximum campaign
   * budget"). One query, two counts, both against the
   * same base rows (every redemption-type transaction referencing one
   * reward). `todayCount` is scoped to UTC-calendar-day-so-far -- a known
   * simplification: this doesn't account for a business's own timezone (a
   * business west of UTC sees its "day" roll over during its own morning;
   * one east of UTC sees it roll over the evening before). Correct
   * business-timezone-aware day boundaries need a timezone source this
   * block doesn't have wired up, and building that is a separate concern
   * from "count today's redemptions" -- disclosed here, not silently
   * assumed correct. `totalCount` is lifetime, not date-scoped: S6.1 lists
   * "maximum rewards per day" and "maximum reward budget" as two separate
   * fields, and nothing in the spec suggests budget resets. The caller
   * (LoyaltyRedemptionService) multiplies `totalCount` by the reward's own
   * `rewardValue` to get budget used, rather than this method summing a
   * per-transaction value -- loyalty_transactions has no rewardValue column
   * of its own, and doesn't need one: every redemption of the SAME reward
   * grants the SAME value (it's a property of the catalog row, not the
   * transaction), so count * rewardValue is the exact sum without a join. */
  async countForLimitCheck(rewardId: string): Promise<{ todayCount: number; totalCount: number }> {
    const [row] = await this.db
      .select({
        todayCount: sql<number>`count(*) filter (where ${loyaltyTransactions.createdAt} >= date_trunc('day', now()))::int`,
        totalCount: sql<number>`count(*)::int`,
      })
      .from(loyaltyTransactions)
      .where(and(eq(loyaltyTransactions.relatedRewardId, rewardId), eq(loyaltyTransactions.type, 'redemption')));
    return { todayCount: row?.todayCount ?? 0, totalCount: row?.totalCount ?? 0 };
  }

  /** Continuing Development Block 6.7.1 (S6.3 campaign dashboard). Reward-
   * scoped redemption counts, split into outstanding vs. redeemed. Same
   * WHERE shape as countForLimitCheck() above (relatedRewardId + type =
   * 'redemption') -- deliberately not a call to that method, since this
   * needs the redeemed/outstanding split it doesn't return and has no use
   * for countForLimitCheck's own todayCount. Kept as two independent
   * methods rather than one with more optional fields, matching this
   * file's existing style (each method describes one real caller's exact
   * need, not a generic do-everything query).
   *
   * redeemedCount uses `redemptionConfirmedAt IS NOT NULL` -- the one
   * state that's actually meaningful across BOTH reward types today. A
   * points-type redemption transaction never gets an issuanceStatus at
   * all (see loyalty-transactions.ts's own column comment); a non-points
   * one gets issuanceStatus 'issued' immediately at creation (Block 6.2's
   * issue(), skipping a separately-observable 'pending' step) and only
   * ever advances to 'redeemed' in lockstep with this same
   * redemptionConfirmedAt column (confirmRedemption() sets both in one
   * guarded UPDATE). So redemptionConfirmedAt already tells the true
   * two-state story for every reward that exists today: outstanding
   * (requested/issued, not yet handed over) or redeemed (confirmed at the
   * counter). 'pending' (as a state distinct from 'issued'), 'expired',
   * and 'reversed' are valid in loyalty_transactions_issuance_status_check
   * but no code path sets any of them yet -- deliberately not reported
   * here rather than showing three permanent zeros dressed up as real
   * data. Disclosed gap, not an oversight -- see this block's completion
   * notes for how to close it if a real caller for those states shows up.
   *
   * outstandingCount is derived (totalCount - redeemedCount) rather than a
   * third FILTER clause, so total = outstanding + redeemed is true by
   * construction instead of by two independently-computed COUNTs that
   * could in principle drift apart. */
  async getCampaignStats(rewardId: string): Promise<{
    totalCount: number;
    redeemedCount: number;
    outstandingCount: number;
  }> {
    const [row] = await this.db
      .select({
        totalCount: sql<number>`count(*)::int`,
        redeemedCount: sql<number>`count(*) filter (where ${loyaltyTransactions.redemptionConfirmedAt} is not null)::int`,
      })
      .from(loyaltyTransactions)
      .where(and(eq(loyaltyTransactions.relatedRewardId, rewardId), eq(loyaltyTransactions.type, 'redemption')));

    const totalCount = row?.totalCount ?? 0;
    const redeemedCount = row?.redeemedCount ?? 0;
    return { totalCount, redeemedCount, outstandingCount: totalCount - redeemedCount };
  }

  /** Continuing Development Block 6.5 (S5.5 "customer cooldown" + S6.1
   * "one reward per ... defined period," the `limitPer: 'period'` case).
   * Most recent redemption/issuance THIS account has of THIS specific
   * reward -- scoped to (rewardId, loyaltyAccountId), unlike
   * countForLimitCheck's campaign-wide (rewardId only) scope above. One
   * row is enough to back both checks LoyaltyRedemptionService runs
   * against it: cooldownSeconds and limitPeriodDays are both "time since
   * this customer's last claim of this reward," just compared against two
   * independently-configurable thresholds -- see that method's own
   * comment. Uses the relational query API (this file's dominant idiom)
   * rather than a raw MAX() aggregate, since "most recent matching row" is
   * exactly what findFirst + orderBy + implicit LIMIT 1 already does. */
  async findLastRedemptionForAccount(
    rewardId: string,
    loyaltyAccountId: string,
  ): Promise<LoyaltyTransaction | undefined> {
    return this.db.query.loyaltyTransactions.findFirst({
      where: and(
        eq(loyaltyTransactions.relatedRewardId, rewardId),
        eq(loyaltyTransactions.loyaltyAccountId, loyaltyAccountId),
        eq(loyaltyTransactions.type, 'redemption'),
      ),
      orderBy: desc(loyaltyTransactions.createdAt),
    });
  }
}
