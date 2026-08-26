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
}
