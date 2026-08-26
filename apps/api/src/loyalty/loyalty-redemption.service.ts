import type { Database } from '../db/client';
import { createRepositories } from '../repositories';
import type { LoyaltyTransaction } from '../repositories';
import { AppError } from '../lib/errors';
import { generateRedemptionCode } from './redemption-code';

export interface RedemptionResult {
  redemptionCode: string;
  pointsSpent: number;
  remainingBalance: number;
}

/** issue()'s result -- no pointsSpent/remainingBalance, since a
 * non-points reward doesn't touch the account's point balance at all. */
export interface IssuanceResult {
  redemptionCode: string;
  reward: { id: string; name: string; type: string };
}

const REDEMPTION_CODE_MAX_ATTEMPTS = 5;

/**
 * Reward redemption: a customer spends points for a code, staff confirms
 * that code at the counter. Two-phase by design -- `redeem` never hands
 * over the actual reward, it only reserves the points and issues a code;
 * `confirmRedemption` is the point where a staff member has visually
 * verified the customer and actually handed over the reward. Split into its
 * own service from LoyaltyAccountService because the two are conceptually
 * different ledger operations (spending against a catalog item vs. generic
 * points engine mutations) even though both write loyalty_transactions.
 */
export class LoyaltyRedemptionService {
  constructor(private readonly db: Database) {}

  async redeem(customerId: string, businessId: string, rewardId: string): Promise<RedemptionResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
      if (!account) {
        throw new AppError('You are not enrolled in this loyalty program yet.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
      }

      const reward = await repos.loyaltyRewards.findById(rewardId, businessId);
      if (!reward || reward.status !== 'active') {
        throw new AppError('This reward is not available.', 404, 'LOYALTY_REWARD_NOT_FOUND');
      }
      // Continuing Development Block 6.2 (S6.2 reward types): redeem() is
      // the points-balance path only. A discount/free_item/voucher reward
      // isn't paid for out of the account's points -- see issue() below.
      // Without this guard, a non-points reward would silently fall through
      // to the pointsCost check next, which is meaningless for those types.
      if (reward.type !== 'points') {
        throw new AppError('Use the issue endpoint for a non-points reward.', 422, 'LOYALTY_REWARD_WRONG_TYPE');
      }
      // pointsCost is nullable at the schema/type level since Block 6.2's
      // correction (non-points rewards don't have one) -- for a
      // 'points'-type reward it must always be set by LoyaltyRewardService
      // (CreateRewardInput.pointsCost is still required there). This is a
      // defensive runtime guard against a row that reached this state some
      // other way (direct DB edit, etc.), and narrows pointsCost to
      // `number` for TypeScript for the rest of this method.
      if (reward.pointsCost === null) {
        throw new AppError('This reward is misconfigured (no points cost).', 500, 'LOYALTY_REWARD_MISCONFIGURED');
      }

      if (account.points < reward.pointsCost) {
        throw new AppError('Not enough points for this reward.', 422, 'INSUFFICIENT_POINTS');
      }

      // Collision odds against the 32^8 alphabet are astronomically low, but
      // the unique index (loyalty_transactions_redemption_code_key) is the
      // real backstop -- this loop just avoids surfacing a raw DB conflict
      // error to the customer on the rare retry.
      let updatedAccount = account;
      let code = '';
      let created: LoyaltyTransaction | undefined;
      for (let attempt = 0; attempt < REDEMPTION_CODE_MAX_ATTEMPTS && !created; attempt++) {
        code = generateRedemptionCode();
        const existing = await repos.loyaltyTransactions.findByRedemptionCode(code);
        if (existing) continue;

        updatedAccount = await repos.loyaltyAccounts.applyPointsDelta(account.id, -reward.pointsCost);
        created = await repos.loyaltyTransactions.create({
          loyaltyAccountId: account.id,
          type: 'redemption',
          points: -reward.pointsCost,
          relatedRewardId: reward.id,
          redemptionCode: code,
        });
      }
      if (!created) {
        throw new AppError('Could not generate a redemption code. Please try again.', 500, 'REDEMPTION_CODE_EXHAUSTED');
      }

      return {
        redemptionCode: code,
        pointsSpent: reward.pointsCost,
        remainingBalance: updatedAccount.points,
      };
    });
  }

  /**
   * Continuing Development Block 6.2 (S6.2 reward types, S6.7 state
   * machine). The non-points counterpart to redeem() -- a discount/
   * free_item/voucher reward is granted, not paid for, so no points ever
   * move and `points` is recorded as 0 (honest: this is not a ledger event
   * for the account's balance, just an audit-trail row).
   *
   * Creates the transaction row directly in issuanceStatus 'issued',
   * skipping a separately-observable 'pending' step: S6.8's
   * reserve-then-issue is one atomic sequence with nothing today that acts
   * between the two, so a caller only ever sees the row after both have
   * already happened. 'pending' stays valid in the schema for a future flow
   * that needs that gap to be observable (e.g. an approval step) --
   * introducing it here with no real distinct behavior behind it would be
   * placeholder logic, not a feature.
   *
   * Deliberately NOT enforcing maxBudget / maxRewardsPerDay / cooldownSeconds
   * / limitPer here -- that enforcement is Continuing Development Block 6.3.
   * This method only checks the reward itself is claimable right now
   * (active, non-points, within its date window if one is set). Issuing
   * with no budget/limit enforcement yet is a known, disclosed gap until
   * 6.3 lands, not an oversight -- do not treat this method as safe for
   * production traffic before 6.3 ships.
   */
  async issue(customerId: string, businessId: string, rewardId: string): Promise<IssuanceResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
      if (!account) {
        throw new AppError('You are not enrolled in this loyalty program yet.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
      }

      const reward = await repos.loyaltyRewards.findById(rewardId, businessId);
      if (!reward || reward.status !== 'active') {
        throw new AppError('This reward is not available.', 404, 'LOYALTY_REWARD_NOT_FOUND');
      }
      if (reward.type === 'points') {
        throw new AppError('Use the redeem endpoint for a points reward.', 422, 'LOYALTY_REWARD_WRONG_TYPE');
      }

      const now = new Date();
      if (reward.startDate && now < reward.startDate) {
        throw new AppError('This reward is not active yet.', 422, 'LOYALTY_REWARD_NOT_STARTED');
      }
      if (reward.expiryDate && now > reward.expiryDate) {
        throw new AppError('This reward has expired.', 422, 'LOYALTY_REWARD_EXPIRED');
      }

      // Same collision-checked code generation as redeem() -- see that
      // method's comment on REDEMPTION_CODE_MAX_ATTEMPTS.
      let code = '';
      let created: LoyaltyTransaction | undefined;
      for (let attempt = 0; attempt < REDEMPTION_CODE_MAX_ATTEMPTS && !created; attempt++) {
        code = generateRedemptionCode();
        const existing = await repos.loyaltyTransactions.findByRedemptionCode(code);
        if (existing) continue;

        created = await repos.loyaltyTransactions.create({
          loyaltyAccountId: account.id,
          type: 'redemption',
          points: 0,
          relatedRewardId: reward.id,
          redemptionCode: code,
          issuanceStatus: 'issued',
        });
      }
      if (!created) {
        throw new AppError('Could not generate a redemption code. Please try again.', 500, 'REDEMPTION_CODE_EXHAUSTED');
      }

      return {
        redemptionCode: code,
        reward: { id: reward.id, name: reward.name, type: reward.type },
      };
    });
  }

  /** Staff-side confirmation (loyalty:manage) -- the code lookup itself
   * doubles as the tenant-scoping check, via the loyalty account's
   * businessId, since redemption_code has no businessId column of its own.
   * Who confirmed it is captured by the platform-wide audit log middleware
   * (auditMetadata set in the route handler), not a column on this table --
   * createdBy on the transaction row already belongs to the customer's
   * original redeem()/issue() call.
   *
   * Continuing Development Block 6.2: also serves a campaign-type code from
   * issue() -- the repository's confirmRedemption() atomically advances
   * issuanceStatus 'issued' -> 'redeemed' in the same guarded update when
   * the row has one, and is a no-op for a legacy points-type row (which
   * never has one). No branching needed here: one confirmation path for
   * staff regardless of which reward type is behind the code.
   *
   * Continuing Development Block 6.3 (S6.8 "eligible branch"): `branchId` is
   * the CONFIRMING staff member's branch context (resolveTenantContext's
   * optional c.get('branchId'), passed in from the route) -- not a
   * parameter threaded through redeem()/issue(). A customer redeeming from
   * the app has no branch context to give (they aren't standing at one);
   * a staff member confirming at the counter already does, via existing
   * tenant-context middleware, so this reuses that instead of adding a new
   * customer-facing contract. `reward.branchId === null` (every reward
   * today, since nothing yet exposes a way to set it) means "any branch,"
   * so this is a no-op against all current data -- fully backward
   * compatible. If the reward can't be resolved (no relatedRewardId, or it
   * has since been removed from the catalog), the branch check is skipped
   * rather than failing the confirmation: this method isn't re-validating
   * the reward's continued existence, only adding one more constraint on
   * top of a redemption that was already legitimately issued. */
  async confirmRedemption(businessId: string, code: string, branchId?: string): Promise<LoyaltyTransaction> {
    const repos = createRepositories(this.db);

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(code.toUpperCase());
    if (!transaction || transaction.type !== 'redemption') {
      throw new AppError('Redemption code not found.', 404, 'REDEMPTION_NOT_FOUND');
    }

    const account = await repos.loyaltyAccounts.findById(transaction.loyaltyAccountId, businessId);
    if (!account) {
      // Code exists, but not for THIS business -- same 404 as "not found" to
      // avoid confirming to staff that the code is valid elsewhere.
      throw new AppError('Redemption code not found.', 404, 'REDEMPTION_NOT_FOUND');
    }

    if (transaction.relatedRewardId) {
      const reward = await repos.loyaltyRewards.findById(transaction.relatedRewardId, businessId);
      if (reward?.branchId && reward.branchId !== branchId) {
        throw new AppError(
          'This reward can only be redeemed at its eligible branch.',
          422,
          'LOYALTY_REDEMPTION_WRONG_BRANCH',
        );
      }
    }

    if (transaction.redemptionConfirmedAt) {
      throw new AppError('This redemption has already been confirmed.', 409, 'REDEMPTION_ALREADY_CONFIRMED');
    }

    // The real guard against a double-confirm race is confirmRedemption's own
    // conditional WHERE (redemptionConfirmedAt IS NULL), not the read above --
    // two concurrent requests can both pass that read before either writes.
    // "Not found" was already ruled out by the transaction/account lookups
    // above, so undefined here can only mean another request won the race.
    const confirmed = await repos.loyaltyTransactions.confirmRedemption(transaction.id);
    if (!confirmed) {
      throw new AppError('This redemption has already been confirmed.', 409, 'REDEMPTION_ALREADY_CONFIRMED');
    }
    return confirmed;
  }

  async lookup(businessId: string, code: string): Promise<LoyaltyTransaction> {
    const repos = createRepositories(this.db);
    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(code.toUpperCase());
    if (!transaction || transaction.type !== 'redemption') {
      throw new AppError('Redemption code not found.', 404, 'REDEMPTION_NOT_FOUND');
    }
    const account = await repos.loyaltyAccounts.findById(transaction.loyaltyAccountId, businessId);
    if (!account) {
      throw new AppError('Redemption code not found.', 404, 'REDEMPTION_NOT_FOUND');
    }
    return transaction;
  }
}
