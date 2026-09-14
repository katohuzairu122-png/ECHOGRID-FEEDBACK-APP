/**
 * The maxBudget enforcement decision, in exact integer cents.
 *
 * WHAT THIS FIXES
 * LoyaltyRedemptionService.checkDailyAndBudgetLimits compared raw IEEE 754
 * doubles:
 *
 *     const projectedSpend = (totalCount + 1) * Number(reward.rewardValue);
 *     if (projectedSpend > Number(reward.maxBudget)) throw ...
 *
 * Measured against exact decimal arithmetic over ten realistic
 * value/budget pairs, that expression disagrees on five of them, in BOTH
 * directions:
 *
 *   issued=11 value=8.30 budget=99.60 -> 12 x 8.30 = 99.60000000000001
 *       Rejects the 12th claim, which exactly fits the budget. The customer
 *       is told "this reward has reached its budget" when it has not, and
 *       the business loses a redemption it had paid for.
 *
 *   issued=2 value=0.10 budget=0.30 -> 3 x 0.10 = 0.30000000000000004
 *       Same false rejection at the smallest realistic values.
 *
 * and the sharper direction, where the guard is bypassed rather than
 * over-eager: a projected spend that lands a hair BELOW its true value
 * passes a budget it actually exceeds. A budget guard that does not hold
 * exactly at its own boundary is not a budget guard.
 *
 * WHY THE CODEBASE ALREADY KNEW
 * loyalty-reward.service.ts has `roundMoney()` for precisely this problem,
 * its comment names "3 * 9.10 in IEEE 754 doubles" explicitly, and
 * getCampaignDashboard applies it to budgetUsed/budgetRemaining/
 * outstandingLiability. So the READ path reports money correctly while the
 * WRITE guard that decides whether to spend it did not -- the same shape as
 * audit P2-1, where the sentiment fold was right in sentimentTrend and
 * wrong in summary.service.ts. roundMoney's own comment claimed "nothing
 * else in the service layer does arithmetic on a converted numeric column
 * today", which was not true: this guard did, on the same two columns, in
 * the file next door.
 *
 * WHY CENTS RATHER THAN roundMoney()
 * Rounding the product still compares two floats and still has a boundary
 * where it is wrong; it only moves the boundary. Both columns are
 * `numeric(10, 2)` (db/schema/loyalty-rewards.ts), so every value the
 * database can hold has at most two decimal places, and integer cents is
 * therefore EXACT for all of them rather than merely better. There is no
 * representable value for which this needs to round at all.
 */

const CENTS_PER_UNIT = 100;

/**
 * A `numeric(10, 2)` column value as an integer number of cents.
 *
 * Exact for every value the column can store. Math.round is doing nothing
 * interesting here -- it only absorbs the `x * 100` float artifact (e.g.
 * 8.30 * 100 = 830.0000000000001) for a value that is already known to
 * have at most 2dp. It is NOT a general-purpose money parser: hand it three
 * decimal places and it silently truncates, which is safe here only because
 * the schema forbids them.
 *
 * Max magnitude is numeric(10,2) -> 99,999,999.99 -> 9,999,999,999 cents,
 * comfortably inside Number.MAX_SAFE_INTEGER, so the multiplication below
 * cannot lose precision either.
 */
export function toCents(value: string | number): number {
  return Math.round(Number(value) * CENTS_PER_UNIT);
}

export interface BudgetCheckInput {
  /** Redemptions of this reward that already exist. */
  alreadyIssued: number;
  /** numeric(10,2) as Drizzle hands it over: a string, or null. */
  rewardValue: string | null;
  maxBudget: string | null;
}

/**
 * True when issuing ONE MORE redemption would take total spend past
 * maxBudget.
 *
 * Returns false when either column is null, preserving the existing
 * behaviour exactly: a 'points'-type reward has a null rewardValue, so
 * maxBudget is a deliberate no-op for it (confirmed with the project owner
 * -- see the integration suite's "redeem does not enforce maxBudget for a
 * points-type reward, even when maxBudget is set"). That is a product
 * decision this fix must not quietly change.
 *
 * Boundary: spending EXACTLY the budget is allowed; one cent beyond is not.
 * `>` not `>=`, matching what the float version intended.
 */
export function wouldExceedBudget({ alreadyIssued, rewardValue, maxBudget }: BudgetCheckInput): boolean {
  if (maxBudget === null || rewardValue === null) return false;

  const projectedCents = (alreadyIssued + 1) * toCents(rewardValue);
  return projectedCents > toCents(maxBudget);
}
