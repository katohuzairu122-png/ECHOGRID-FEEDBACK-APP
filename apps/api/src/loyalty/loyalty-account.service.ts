import type { Database } from '../db/client';
import {
  createRepositories,
  type Repositories,
  type LoyaltyAccount,
  type LoyaltyAccountWithCustomer,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface EnrollInput {
  customerId: string;
  businessId: string;
  referredByCustomerId?: string;
}

export interface LoyaltyAccountSummary {
  account: LoyaltyAccount;
  recentTransactions: Awaited<ReturnType<Repositories['loyaltyTransactions']['listForAccount']>>;
}

/**
 * The points engine: every operation that changes a balance goes through
 * this service, never a raw repository call from a route handler, so the
 * "apply delta -> recompute tier -> write ledger row" sequence is never
 * duplicated or partially applied. Constructor-injected with the raw
 * Database (not Repositories) -- same exception BusinessService takes --
 * because every earning/spending method needs a transaction spanning the
 * account update and the ledger insert.
 */
export class LoyaltyAccountService {
  constructor(private readonly db: Database) {}

  /** Creates a business membership for a customer who doesn't have one yet
   * (idempotent -- returns the existing account if already enrolled). A
   * referral, if given, awards the REFERRER's account a bonus once, at the
   * moment their referral actually joins -- not before, since an
   * unconverted referral link has earned nothing yet. */
  async enroll(input: EnrollInput): Promise<LoyaltyAccount> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const existing = await repos.loyaltyAccounts.findByCustomerAndBusiness(
        input.customerId,
        input.businessId,
      );
      if (existing) return existing;

      const account = await repos.loyaltyAccounts.create({
        customerId: input.customerId,
        businessId: input.businessId,
        referredByCustomerId: input.referredByCustomerId ?? null,
      });

      if (input.referredByCustomerId) {
        const referrerAccount = await repos.loyaltyAccounts.findByCustomerAndBusiness(
          input.referredByCustomerId,
          input.businessId,
        );
        // Referrer must already be a member here -- a referral code with no
        // matching account is silently ignored rather than failing the new
        // member's own enrollment over it.
        if (referrerAccount) {
          const settings = await repos.loyaltySettings.getOrCreateDefaults(input.businessId);
          await this.applyEarning(repos, referrerAccount, 'referral_bonus', settings.referralBonusPoints, {});
        }
      }

      return account;
    });
  }

  /** Auto-enrolls on first scan -- a customer tapping a business's QR code
   * for the first time shouldn't need a separate "join" step. */
  async recordCheckin(
    customerId: string,
    businessId: string,
    qrCodeId: string,
  ): Promise<LoyaltyAccount> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      let account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
      if (!account) {
        account = await repos.loyaltyAccounts.create({ customerId, businessId });
      }

      const settings = await repos.loyaltySettings.getOrCreateDefaults(businessId);
      return this.applyEarning(repos, account, 'checkin', settings.pointsPerCheckin, {
        relatedQrCodeId: qrCodeId,
        recordVisit: true,
      });
    });
  }

  /** Staff-recorded purchase (loyalty:manage). Points are floored, never
   * rounded up -- a business's per-currency-unit rate is a promise to the
   * customer, and rounding in the business's favor is the safer default. */
  async recordPurchase(
    businessId: string,
    accountId: string,
    purchaseAmount: number,
    staffUserId: string,
  ): Promise<LoyaltyAccount> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const account = await this.requireAccount(repos, accountId, businessId);

      const settings = await repos.loyaltySettings.getOrCreateDefaults(businessId);
      const points = Math.floor(purchaseAmount * Number(settings.pointsPerCurrencyUnit));

      return this.applyEarning(repos, account, 'purchase', points, {
        purchaseAmount: purchaseAmount.toFixed(2),
        createdBy: staffUserId,
      });
    });
  }

  /** Manual staff correction (loyalty:manage) -- can be positive or
   * negative. Pre-checked against going below zero here (a clear 422)
   * rather than relying on the DB CHECK constraint to reject the whole
   * transaction with a raw Postgres error. */
  async adjustPoints(
    businessId: string,
    accountId: string,
    pointsDelta: number,
    notes: string | undefined,
    staffUserId: string,
  ): Promise<LoyaltyAccount> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const account = await this.requireAccount(repos, accountId, businessId);

      if (account.points + pointsDelta < 0) {
        throw new AppError(
          'This adjustment would drop the balance below zero.',
          422,
          'INSUFFICIENT_POINTS',
        );
      }

      return this.applyEarning(repos, account, 'adjustment', pointsDelta, {
        notes,
        createdBy: staffUserId,
      });
    });
  }

  async getAccount(accountId: string, businessId: string): Promise<LoyaltyAccount> {
    const repos = createRepositories(this.db);
    return this.requireAccount(repos, accountId, businessId);
  }

  async listForCustomer(customerId: string): Promise<LoyaltyAccount[]> {
    const repos = createRepositories(this.db);
    return repos.loyaltyAccounts.listForCustomer(customerId);
  }

  async listForBusiness(
    businessId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LoyaltyAccountWithCustomer[]> {
    const repos = createRepositories(this.db);
    return repos.loyaltyAccounts.listForBusiness(businessId, options);
  }

  async getSummary(customerId: string, businessId: string): Promise<LoyaltyAccountSummary | undefined> {
    const repos = createRepositories(this.db);
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
    if (!account) return undefined;

    const recentTransactions = await repos.loyaltyTransactions.listForAccount(account.id, {
      limit: 20,
    });
    return { account, recentTransactions };
  }

  async listTransactions(
    businessId: string,
    accountId: string,
    options: { limit?: number; offset?: number } = {},
  ) {
    const repos = createRepositories(this.db);
    await this.requireAccount(repos, accountId, businessId);
    return repos.loyaltyTransactions.listForAccount(accountId, options);
  }

  private async requireAccount(
    repos: Repositories,
    accountId: string,
    businessId: string,
  ): Promise<LoyaltyAccount> {
    const account = await repos.loyaltyAccounts.findById(accountId, businessId);
    if (!account) {
      throw new AppError('Loyalty account not found.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
    }
    return account;
  }

  /**
   * Shared sequence for every point-earning/spending operation: apply the
   * delta, recompute tier eligibility against the NEW balance (only knowable
   * after the delta lands), then write the immutable ledger row. All three
   * steps run against the same tx-scoped `repos` the caller already opened,
   * so this never opens its own transaction.
   */
  private async applyEarning(
    repos: Repositories,
    account: LoyaltyAccount,
    type: 'checkin' | 'purchase' | 'referral_bonus' | 'birthday_bonus' | 'adjustment',
    points: number,
    extra: {
      relatedQrCodeId?: string;
      purchaseAmount?: string;
      notes?: string;
      createdBy?: string;
      recordVisit?: boolean;
    },
  ): Promise<LoyaltyAccount> {
    let updated = await repos.loyaltyAccounts.applyPointsDelta(account.id, points, {
      recordVisit: extra.recordVisit,
    });

    const eligibleTier = await repos.loyaltyTiers.findHighestEligible(account.businessId, updated.points);
    const eligibleTierId = eligibleTier?.id ?? null;
    if (eligibleTierId !== updated.tierId) {
      updated = await repos.loyaltyAccounts.updateTier(account.id, eligibleTierId);
    }

    await repos.loyaltyTransactions.create({
      loyaltyAccountId: account.id,
      type,
      points,
      relatedQrCodeId: extra.relatedQrCodeId ?? null,
      purchaseAmount: extra.purchaseAmount ?? null,
      notes: extra.notes ?? null,
      createdBy: extra.createdBy ?? null,
    });

    return updated;
  }
}
