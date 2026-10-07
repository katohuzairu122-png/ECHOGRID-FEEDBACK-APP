import type { Database } from '../db/client';
import {
  createRepositories,
  type Repositories,
  type LoyaltyAccount,
  type LoyaltyAccountWithCustomer,
} from '../repositories';
import { AppError } from '../lib/errors';
import type { LoyaltyPurchaseChannel } from '../db/schema';

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

  /** Records a check-in only for an already-active business membership.
   * Split 01 removes silent QR auto-enrollment: relationship creation is an
   * explicit consented action handled by CustomerMembershipService.
   *
   * `visitSessionId` is optional and only ever set by the caller when Block
   * 4.3.2's visit verification actually succeeded on this request -- see
   * loyalty-customer.routes.ts's checkin handler. When present, Block 5.2
   * (S5.7 one reward per qualifying visit) enforces at most one 'checkin'
   * reward per (visitSessionId, account) pair: checked AFTER auto-enrollment
   * above so a brand-new member's first-ever check-in at a shared
   * table-session code still earns normally (there is provably no prior
   * transaction for an account that didn't exist a moment ago). When
   * absent -- no visitProof was submitted, or verification failed -- this
   * behaves exactly as before Block 5.2: every call earns, gated only by
   * the existing cooldown in the route handler. That is a deliberate,
   * bounded gap, not an oversight: verification staying advisory-only
   * (Block 4.3.2) means a failed/exhausted proof falls back to ordinary
   * cooldown-gated earning rather than blocking the checkin outright, the
   * same as if no visitProof had been sent at all. */
  async recordCheckin(
    customerId: string,
    businessId: string,
    qrCodeId: string,
    visitSessionId?: string,
  ): Promise<LoyaltyAccount> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const membership = await repos.customerMemberships.findActive(customerId, businessId);
      if (!membership) {
        throw new AppError(
          'Join this loyalty program before checking in.',
          409,
          'MEMBERSHIP_REQUIRED',
        );
      }

      const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
      if (!account) {
        throw new AppError(
          'Your loyalty account is not ready for this membership.',
          409,
          'LOYALTY_ACCOUNT_NOT_READY',
        );
      }
      if (account.membershipId && account.membershipId !== membership.id) {
        throw new AppError(
          'Loyalty membership mapping is inconsistent.',
          409,
          'MEMBERSHIP_MAPPING_CONFLICT',
        );
      }

      if (visitSessionId) {
        const already = await repos.loyaltyTransactions.findCheckinByVisitSession(account.id, visitSessionId);
        if (already) return account;
      }

      const settings = await repos.loyaltySettings.getOrCreateDefaults(businessId);
      return this.applyEarning(repos, account, 'checkin', settings.pointsPerCheckin, {
        relatedQrCodeId: qrCodeId,
        visitSessionId,
        recordVisit: true,
      });
    });
  }

  /** Staff-recorded qualifying purchase. Split 03 gives the purchase its
   * own durable idempotent evidence row before any loyalty value moves. */
  async recordPurchase(input: {
    businessId: string;
    branchId?: string;
    accountId: string;
    purchaseAmount: number;
    idempotencyKey: string;
    externalReference?: string;
    channel: LoyaltyPurchaseChannel;
    staffUserId: string;
  }): Promise<{ account: LoyaltyAccount; inserted: boolean }> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const account = await this.requireAccount(repos, input.accountId, input.businessId);

      const membership = await repos.customerMemberships.findActive(account.customerId, input.businessId);
      if (!membership || (account.membershipId && account.membershipId !== membership.id)) {
        throw new AppError(
          'An active customer membership is required before loyalty progress can be granted.',
          409,
          'MEMBERSHIP_REQUIRED',
        );
      }

      const amount = input.purchaseAmount.toFixed(2);
      const { event, inserted } = await repos.loyaltyPurchaseEvents.createIdempotent({
        businessId: input.businessId,
        branchId: input.branchId ?? null,
        customerId: account.customerId,
        membershipId: membership.id,
        loyaltyAccountId: account.id,
        idempotencyKey: input.idempotencyKey,
        externalReference: input.externalReference ?? null,
        channel: input.channel,
        qualifyingAmount: amount,
        paymentStatus: 'confirmed',
        createdBy: input.staffUserId,
      });

      if (!inserted) {
        const sameRequest =
          event.loyaltyAccountId === account.id &&
          event.qualifyingAmount === amount &&
          event.branchId === (input.branchId ?? null) &&
          event.channel === input.channel &&
          event.externalReference === (input.externalReference ?? null) &&
          event.paymentStatus === 'confirmed';

        if (!sameRequest) {
          throw new AppError(
            'This idempotency key was already used for a different purchase.',
            409,
            'IDEMPOTENCY_CONFLICT',
          );
        }
        return { account, inserted: false };
      }

      const settings = await repos.loyaltySettings.getOrCreateDefaults(input.businessId);
      const points = Math.floor(input.purchaseAmount * Number(settings.pointsPerCurrencyUnit));

      const updated = await this.applyEarning(repos, account, 'purchase', points, {
        purchaseAmount: amount,
        purchaseEventId: event.id,
        createdBy: input.staffUserId,
      });
      return { account: updated, inserted: true };
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
    options: { limit?: number | undefined; offset?: number | undefined } = {},
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
    options: { limit?: number | undefined; offset?: number | undefined } = {},
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
      relatedQrCodeId?: string | undefined;
      visitSessionId?: string | undefined;
      purchaseAmount?: string | undefined;
      purchaseEventId?: string | undefined;
      notes?: string | undefined;
      createdBy?: string | undefined;
      recordVisit?: boolean | undefined;
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
      visitSessionId: extra.visitSessionId ?? null,
      purchaseAmount: extra.purchaseAmount ?? null,
      purchaseEventId: extra.purchaseEventId ?? null,
      notes: extra.notes ?? null,
      createdBy: extra.createdBy ?? null,
    });

    return updated;
  }
}
