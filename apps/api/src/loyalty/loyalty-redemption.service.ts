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

  /** Staff-side confirmation (loyalty:manage) -- the code lookup itself
   * doubles as the tenant-scoping check, via the loyalty account's
   * businessId, since redemption_code has no businessId column of its own.
   * Who confirmed it is captured by the platform-wide audit log middleware
   * (auditMetadata set in the route handler), not a column on this table --
   * createdBy on the transaction row already belongs to the customer's
   * original redeem() call. */
  async confirmRedemption(businessId: string, code: string): Promise<LoyaltyTransaction> {
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

    if (transaction.redemptionConfirmedAt) {
      throw new AppError('This redemption has already been confirmed.', 409, 'REDEMPTION_ALREADY_CONFIRMED');
    }

    const confirmed = await repos.loyaltyTransactions.confirmRedemption(transaction.id);
    if (!confirmed) {
      throw new AppError('Redemption code not found.', 404, 'REDEMPTION_NOT_FOUND');
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
