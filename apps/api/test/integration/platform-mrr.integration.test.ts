import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/**
 * BusinessSubscriptionRepository.calculateMrr against real Postgres
 * (audit P2-4).
 *
 * WHY THIS TIER AND NOT A UNIT TEST
 * The whole method IS one SQL aggregate, deliberately -- its own doc comment
 * rejects fetching rows and reducing in JS, "per design for global scale".
 * Both defects it had were therefore SQL semantics, not JavaScript:
 *
 *   - SUM skips NULL while COUNT(*) counts the row
 *   - `integer / 12` truncates, per row, before the SUM
 *
 * Neither is reproducible without a database. A fake repository would have
 * re-encoded the intended behaviour in JavaScript and agreed with itself.
 *
 * PLATFORM-WIDE, SO THIS SUITE MUST STAY SERIAL. calculateMrr aggregates
 * every active subscription in the table regardless of business, exactly
 * like ai-usage-stale-pending's abandonStalePending/totalCostSince. Another
 * file writing subscriptions concurrently would change these numbers --
 * which is the second reason vitest.integration.config.ts's
 * `fileParallelism: false` must stay false, now with two suites depending
 * on it rather than one.
 *
 * It also means this suite CANNOT assert absolute platform totals: a dev or
 * CI database may already hold subscriptions. Every assertion below is
 * therefore a DELTA against a baseline captured immediately before the
 * rows under test are inserted.
 *
 * Requires migrations applied (`pnpm db:migrate`). Point at a scratch/dev
 * database, never production.
 */
describe.skipIf(!process.env.DATABASE_URL)('platform MRR (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;

  const SUITE_TAG = `mrr-test-${crypto.randomUUID()}`;
  const businessIds: string[] = [];
  const planIds: string[] = [];

  /** Captured before each test's own inserts, so assertions are deltas. */
  let baseline: { mrrCents: number; activeSubscriptionCount: number };

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));
  });

  afterAll(async () => {
    // Hard deletes here, unlike the soft-delete-only cleanup the other
    // integration suites use -- and deliberately: a leftover
    // business_subscriptions row keeps counting toward every future MRR
    // reading in this database, which is exactly the cross-test pollution
    // this suite's own delta() comment warns about. Soft-deleting would not
    // help, because calculateMrr filters on status, not on isDeleted.
    //
    // Verified safe rather than assumed: businesses.create writes no
    // audit_log row, and audit_log.business_id is ON DELETE SET NULL, so
    // purging these businesses cannot hit a foreign key. Ordered
    // child-then-parent regardless.
    if (businessIds.length > 0) {
      await client.query(
        `DELETE FROM business_subscriptions WHERE business_id = ANY($1)`,
        [businessIds],
      );
    }
    if (planIds.length > 0) {
      await client.query(`DELETE FROM subscription_plans WHERE id = ANY($1)`, [planIds]);
    }
    await client.query(`DELETE FROM businesses WHERE slug LIKE $1`, [`${SUITE_TAG}%`]);
    await client.end();
  });

  beforeEach(async () => {
    baseline = await repos.businessSubscriptions.calculateMrr();
  });

  async function makePlan(input: {
    priceMonthlyCents: number;
    priceYearlyCents: number | null;
  }): Promise<string> {
    const plan = await repos.subscriptionPlans.create({
      key: `${SUITE_TAG}-plan-${crypto.randomUUID()}`,
      name: 'MRR Test Plan',
      priceMonthlyCents: input.priceMonthlyCents,
      priceYearlyCents: input.priceYearlyCents,
    });
    planIds.push(plan.id);
    return plan.id;
  }

  async function makeSubscription(input: {
    planId: string;
    status?: string;
    billingInterval?: 'month' | 'year' | null;
  }): Promise<void> {
    const business = await repos.businesses.create({
      name: 'MRR Test Business',
      slug: `${SUITE_TAG}-${crypto.randomUUID()}`,
    });
    businessIds.push(business.id);

    await repos.businessSubscriptions.create({
      businessId: business.id,
      planId: input.planId,
      status: input.status ?? 'active',
      billingInterval: input.billingInterval === undefined ? 'month' : input.billingInterval,
    });
  }

  /**
   * The two numbers this method returns, as deltas from the baseline.
   *
   * CONSTRAINT ON EVERY TEST BELOW: its own MRR contribution must be a
   * WHOLE number of cents. ROUND is applied to the platform-wide total, so
   * `ROUND(baseline + k) - ROUND(baseline)` equals `k` only when k is an
   * integer. With a fractional k, a fractional baseline -- which a dev
   * database holding yearly subscriptions will have -- shifts the delta by
   * one cent and the test fails for a reason that has nothing to do with
   * the code. Hence "yearly x3 @29900" (exactly 7475) rather than a single
   * yearly subscription (2491.666...) wherever a delta is asserted.
   *
   * A fresh CI database migrates from empty, so its baseline is 0 and this
   * would not bite there. It would bite locally, intermittently, and look
   * like a real regression -- the same class of trap as the reason
   * fileParallelism must stay false.
   */
  async function delta(): Promise<{ mrr: number; count: number }> {
    const now = await repos.businessSubscriptions.calculateMrr();
    return {
      mrr: now.mrrCents - baseline.mrrCents,
      count: now.activeSubscriptionCount - baseline.activeSubscriptionCount,
    };
  }

  it('counts a monthly subscription at the plan monthly price', async () => {
    const planId = await makePlan({ priceMonthlyCents: 2900, priceYearlyCents: 29900 });
    await makeSubscription({ planId, billingInterval: 'month' });

    expect(await delta()).toEqual({ mrr: 2900, count: 1 });
  });

  it('does not truncate a yearly price per row -- the accumulating half of P2-4', async () => {
    // $299/yr is 29900/12 = 2491.666... cents per month.
    //   old code (integer division, truncated per row): 2491 x 3 = 7473
    //   rounding per row and then summing:              2492 x 3 = 7476
    //   exact division, summed, rounded once:                      7475  <-
    // So this asserts BOTH that the truncation is gone and that the fix
    // rounds once at the end rather than per row.
    const planId = await makePlan({ priceMonthlyCents: 2900, priceYearlyCents: 29900 });
    await makeSubscription({ planId, billingInterval: 'year' });
    await makeSubscription({ planId, billingInterval: 'year' });
    await makeSubscription({ planId, billingInterval: 'year' });

    expect(await delta()).toEqual({ mrr: 7475, count: 3 });
  });

  it('keeps the error from growing with subscriber count', async () => {
    // The property truncation destroyed: twelve subscribers on a yearly
    // plan must contribute exactly one year's price per month, to the cent.
    // Old code: floor(29900/12) x 12 = 29892, i.e. 8 cents lost -- and the
    // loss scales linearly with headcount.
    const planId = await makePlan({ priceMonthlyCents: 2900, priceYearlyCents: 29900 });
    for (let i = 0; i < 12; i++) {
      await makeSubscription({ planId, billingInterval: 'year' });
    }

    expect(await delta()).toEqual({ mrr: 29900, count: 12 });
  });

  it('still counts a yearly subscription whose plan has NO yearly price -- the disagreeing half of P2-4', async () => {
    // THE defect. price_yearly_cents is nullable and nothing constrains it
    // against a subscription's billing_interval, so the old CASE produced
    // NULL here. SUM skipped the row; COUNT(*) kept it. The dashboard then
    // reported a subscription that contributed nothing, with no indication.
    //
    // Against the pre-fix code this returns { mrr: 0, count: 1 } -- the two
    // numbers disagreeing, which is what makes it a correctness bug and not
    // a rounding one.
    const planId = await makePlan({ priceMonthlyCents: 4900, priceYearlyCents: null });
    await makeSubscription({ planId, billingInterval: 'year' });

    expect(await delta()).toEqual({ mrr: 4900, count: 1 });
  });

  it('prices every subscription it counts, across a mixed population', async () => {
    // The invariant worth stating directly: no counted subscription may
    // contribute zero. Mixes all three interval cases, including the
    // null-yearly-price one, so a regression in any single branch breaks
    // the relationship between the two returned numbers.
    const normalPlan = await makePlan({ priceMonthlyCents: 2900, priceYearlyCents: 29900 });
    const monthlyOnlyPlan = await makePlan({ priceMonthlyCents: 4900, priceYearlyCents: null });

    await makeSubscription({ planId: normalPlan, billingInterval: 'month' }); // 2900
    // THREE yearly, not one, so this test's own contribution is a whole
    // number of cents (3 x 29900 / 12 = exactly 7475) -- see delta()'s
    // comment for why a fractional contribution would make this flaky
    // against any database that already holds yearly subscriptions.
    await makeSubscription({ planId: normalPlan, billingInterval: 'year' });
    await makeSubscription({ planId: normalPlan, billingInterval: 'year' });
    await makeSubscription({ planId: normalPlan, billingInterval: 'year' });
    await makeSubscription({ planId: monthlyOnlyPlan, billingInterval: 'year' }); // 4900 fallback
    await makeSubscription({ planId: monthlyOnlyPlan, billingInterval: null }); // 4900, NULL -> monthly

    // 2900 + 7475 + 4900 + 4900 = 20175
    expect(await delta()).toEqual({ mrr: 20175, count: 6 });
  });

  it('treats a NULL billing_interval as monthly', async () => {
    // Documented behaviour, not an accident: SQL's `NULL = 'year'` is
    // neither true nor false, so CASE takes ELSE. Asserted so that stays a
    // decision -- if someone later makes the column notNull, this test says
    // what the old rows were being counted as.
    const planId = await makePlan({ priceMonthlyCents: 1500, priceYearlyCents: 15000 });
    await makeSubscription({ planId, billingInterval: null });

    expect(await delta()).toEqual({ mrr: 1500, count: 1 });
  });

  it('ignores every non-active status', async () => {
    const planId = await makePlan({ priceMonthlyCents: 9900, priceYearlyCents: 99000 });
    for (const status of ['trialing', 'past_due', 'canceled', 'incomplete', 'unpaid']) {
      await makeSubscription({ planId, status, billingInterval: 'month' });
    }

    expect(await delta()).toEqual({ mrr: 0, count: 0 });
  });

  it('returns 0 rather than NULL or NaN when nothing is active', async () => {
    // COALESCE wraps ROUND(SUM(...)), and SUM over no rows is NULL. If the
    // COALESCE were inside the ROUND instead, this would surface as NaN
    // after Number() -- and a NaN would render as "$NaN" on the platform
    // billing page, which divides by 100.
    const result = await repos.businessSubscriptions.calculateMrr();

    expect(Number.isNaN(result.mrrCents)).toBe(false);
    expect(Number.isInteger(result.mrrCents)).toBe(true);
    expect(result.mrrCents).toBeGreaterThanOrEqual(0);
  });

  it('returns an integer, as the DTO contract requires', async () => {
    // platformMrrSummarySchema declares mrrCents as z.number().int(), and
    // exact numeric division produces a fraction -- so the ROUND is load
    // bearing, not cosmetic. A yearly-only population is the case that
    // would otherwise be fractional.
    const planId = await makePlan({ priceMonthlyCents: 2900, priceYearlyCents: 29900 });
    await makeSubscription({ planId, billingInterval: 'year' });

    const result = await repos.businessSubscriptions.calculateMrr();
    expect(Number.isInteger(result.mrrCents)).toBe(true);
  });
});
