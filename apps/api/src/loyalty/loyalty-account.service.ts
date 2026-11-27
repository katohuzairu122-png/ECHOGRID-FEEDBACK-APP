import type { Database } from '../db/client';
import {
  createRepositories,
  type Repositories,
  type LoyaltyAccount,
  type LoyaltyAccountWithCustomer,
} from '../repositories';
import { AppError } from '../lib/errors';
import { MoneyError, formatMoney, minorFromStored, currencyExponent, parseMoney } from '@echo-grid-feedback/shared-types';
import { resolveActiveProgramme } from './programs/program.service';
import { recordPurchaseStamp } from './programs/stamp.service';
import { recordProgrammeProgress } from './programs/progress.service';
import { moneyStorageScale } from './money-storage';
import { reversePurchaseProgress, type ProgressReversalResult } from './programs/reversal.service';
import { computeCheckinEarning, computePurchaseEarning, type EarningProvenance } from './programs/earning';
import { assertCashierSessionBound, type CashierSessionBinding } from '../cashier-sessions/session-binding';
import {
  assertMembershipGate,
  evaluateMembershipGate,
} from '../customer-relationships/membership-gate';
import { businesses, loyaltyPurchaseEvents, loyaltyTransactions, type LoyaltyPurchaseChannel } from '../db/schema';
import { and, eq } from 'drizzle-orm';

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
export interface ReversePurchaseInput { businessId: string; purchaseEventId: string; reason: string; actorUserId: string }
export interface PurchaseReversalResult {
  purchaseEventId: string;
  accountId: string;
  pointsEarned: number;
  pointsReversed: number;
  pointsShortfall: number;
  progress: ProgressReversalResult;
}
/** Carries the result out of a deliberately rolled-back preview transaction. */
class PreviewComplete extends Error {
  constructor(readonly result: PurchaseReversalResult) {
    super('preview complete');
  }
}

export class LoyaltyAccountService {
  constructor(private readonly db: Database) {}

  /**
   * @deprecated Legacy enrolment; do not use it for new code. It creates a
   * loyalty account with no membership and no JOIN_LOYALTY consent, and the
   * check-in and redeem gates refuse such an account (MEMBERSHIP_REQUIRED).
   * Join through `CustomerMembershipService.join`, which records the
   * membership, the consent and the account together. Nothing calls this, so
   * the referral bonus below is unreachable as well.
   *
   * Creates a business membership for a customer who doesn't have one yet
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
          await this.applyEarning(
            repos,
            referrerAccount,
            'referral_bonus',
            settings.referralBonusPoints,
            {},
          );
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
      // Share-locks the membership row so a concurrent leave or consent withdrawal is ordered
      // against this earning: it either finishes first (and this is refused) or waits for us.
      const { account } = await this.resolveCheckinContext(repos, customerId, businessId, {
        lockMembership: true,
      });

      if (visitSessionId) {
        const already = await repos.loyaltyTransactions.findCheckinByVisitSession(
          account.id,
          visitSessionId,
        );
        if (already) return account;
      }

      const settings = await repos.loyaltySettings.getOrCreateDefaults(businessId);
      const resolvedProgramme = await resolveActiveProgramme(tx, businessId);
      const earning = computeCheckinEarning(resolvedProgramme, {
        pointsPerCheckin: settings.pointsPerCheckin,
        pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit,
      });
      const ledgerId = crypto.randomUUID();
      const updated = await this.applyEarning(repos, account, 'checkin', earning.points, {
        id: ledgerId,
        relatedQrCodeId: qrCodeId,
        visitSessionId,
        recordVisit: true,
        ...(earning.provenance ? { provenance: earning.provenance } : {}),
        ...(earning.note ? { notes: earning.note } : {}),
      });
      if (resolvedProgramme.kind === 'programme' && ['LP-04', 'LP-05', 'LP-07'].includes(resolvedProgramme.type)) {
        const business = await repos.businesses.findById(businessId);
        await recordProgrammeProgress(tx, {
          businessId,
          programId: resolvedProgramme.programId,
          programVersion: resolvedProgramme.version,
          type: resolvedProgramme.type as 'LP-04' | 'LP-05' | 'LP-07',
          config: resolvedProgramme.config,
          loyaltyAccountId: account.id,
          customerId: account.customerId,
          eventKey: `checkin:${ledgerId}`,
          event: { kind: 'visit', occurredAt: new Date() },
          timeZone: business?.defaultTimezone ?? 'UTC',
        });
      }
      return updated;
    });
  }

  /** Read-only preflight for the customer check-in route (Split 01).
   *
   * Runs the same membership/account preconditions as `recordCheckin`, but
   * outside a transaction and without writing anything, so the route can
   * reject a non-member BEFORE it touches any check-in side effect (velocity
   * counters, visit-proof verification, the KV cooldown). Without this, a
   * non-member's first scan reserved the cooldown, the follow-up "join, then
   * check in" call found the new account in cooldown and answered with it
   * unchanged -- a successful-looking check-in that awarded no points.
   * `recordCheckin` re-checks inside its transaction, so this is a gate, not
   * a replacement for that guard. */
  async assertCheckinReady(customerId: string, businessId: string): Promise<void> {
    await this.resolveCheckinContext(createRepositories(this.db), customerId, businessId);
  }

  /** Single source of truth for the check-in preconditions, shared by
   * `assertCheckinReady` (preflight) and `recordCheckin` (authoritative,
   * inside the earning transaction). The rule itself -- an active membership
   * and a usable, consistently mapped account -- lives in the shared
   * membership gate, the same one customer redemption goes through.
   * `lockMembership` is for the in-transaction caller only. */
  private resolveCheckinContext(
    repos: Repositories,
    customerId: string,
    businessId: string,
    options: { lockMembership?: boolean } = {},
  ) {
    return assertMembershipGate(repos, {
      customerId,
      businessId,
      action: 'checkin',
      ...(options.lockMembership ? { lockMembership: true } : {}),
    });
  }

  /** Staff-recorded qualifying purchase. Split 03 gives the purchase its
   * own durable idempotent evidence row before any loyalty value moves. */
  async recordPurchase(input: {
    businessId: string;
    branchId?: string;
    accountId: string;
    /** A decimal number or, for exactness, its decimal text. */
    purchaseAmount: number | string;
    idempotencyKey: string;
    externalReference?: string;
    channel: LoyaltyPurchaseChannel;
    staffUserId: string;
    /** CASHIER-AUTH-02C: for a cashier token, the session binding the request was authorised under (see session-binding.ts). */
    cashierSession?: CashierSessionBinding;
  }): Promise<{ account: LoyaltyAccount; inserted: boolean }> {
    return this.db.transaction(async (tx) => {
      // Ordering against a concurrent branch switch: the shared session lock is taken BEFORE anything is read or written.
      if (input.cashierSession) await assertCashierSessionBound(tx, input.cashierSession);
      const repos = createRepositories(tx);
      const { account, membership } = await this.requireEligibleEarningAccount(
        repos,
        input.accountId,
        input.businessId,
      );

      const business = await repos.businesses.findById(input.businessId);
      if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
      const currency = business.defaultCurrency;
      const amountMinor = this.parseQualifyingAmount(input.purchaseAmount, currency, await moneyStorageScale(tx));
      const amount = formatMoney(amountMinor, currency).replace(/(\.\d\d)0$/, '$1');
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
          minorFromStored(event.qualifyingAmount, currency) === amountMinor &&
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
      const resolvedProgramme = await resolveActiveProgramme(tx, input.businessId);
      const earning = computePurchaseEarning(
        resolvedProgramme,
        { pointsPerCheckin: settings.pointsPerCheckin, pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit },
        { amountMinor, currency, occurredAt: event.occurredAt, timeZone: business.defaultTimezone },
      );

      if (resolvedProgramme.kind === 'programme' && resolvedProgramme.type === 'LP-01') {
        await recordPurchaseStamp(tx, {
          businessId: input.businessId,
          programId: resolvedProgramme.programId,
          programVersion: resolvedProgramme.version,
          config: resolvedProgramme.config,
          loyaltyAccountId: account.id,
          customerId: account.customerId,
          purchaseEventId: event.id,
          occurredAt: event.occurredAt,
          fact: { amountMinor, currency },
        });
      } else if (resolvedProgramme.kind === 'programme' && ['LP-04', 'LP-05', 'LP-07'].includes(resolvedProgramme.type)) {
        await recordProgrammeProgress(tx, {
          businessId: input.businessId,
          programId: resolvedProgramme.programId,
          programVersion: resolvedProgramme.version,
          type: resolvedProgramme.type as 'LP-04' | 'LP-05' | 'LP-07',
          config: resolvedProgramme.config,
          loyaltyAccountId: account.id,
          customerId: account.customerId,
          eventKey: `purchase:${event.id}`,
          purchaseEventId: event.id,
          event: { kind: 'purchase', amountMinor, currency, occurredAt: event.occurredAt },
          timeZone: business.defaultTimezone,
        });
      }

      const updated = await this.applyEarning(repos, account, 'purchase', earning.points, {
        purchaseAmount: amount,
        purchaseEventId: event.id,
        createdBy: input.staffUserId,
        ...(earning.provenance ? { provenance: earning.provenance } : {}),
        ...(earning.note ? { notes: earning.note } : {}),
      });
      return { account: updated, inserted: true };
    });
  }

  /**
   * Exact qualifying amount in minor units. More precision than the currency allows is REFUSED, never rounded (RW-D7). Until the storage
   * columns are widened for three-decimal currencies, an amount whose third decimal is not zero cannot be stored exactly and is refused too.
   */
  private parseQualifyingAmount(value: number | string, currency: string, storageScale: number): bigint {
    let minor: bigint;
    try {
      minor = parseMoney(value, currency);
    } catch (error) {
      if (error instanceof MoneyError) {
        throw new AppError(error.message, 422, 'INVALID_PURCHASE_AMOUNT');
      }
      throw error;
    }
    const exponent = currencyExponent(currency);
    // LPC-14: the database stores `storageScale` decimals (2 until migration 0108 is applied, 3 afterwards). An amount that needs more is refused,
    // never rounded: PostgreSQL would otherwise round it silently on insert.
    if (exponent > storageScale && minor % 10n ** BigInt(exponent - storageScale) !== 0n) {
      throw new AppError(
        `This amount needs ${exponent} decimal places, which the loyalty ledger cannot store yet. Enter it with ${storageScale} decimals.`,
        422,
        'AMOUNT_PRECISION_NOT_SUPPORTED',
      );
    }
    return minor;
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
      // Positive adjustments earn value and must use the same lock order as purchases.
      // Negative corrections retain their existing behavior and take only the account lock.
      const account =
        pointsDelta > 0
          ? (await this.requireEligibleEarningAccount(repos, accountId, businessId)).account
          : await repos.loyaltyAccounts.lockForUpdate(accountId, businessId);
      if (!account)
        throw new AppError('Loyalty account not found.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');

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

  /**
   * LPC-08: reverses one confirmed purchase (a refund or a mistaken receipt). Owner-approved rules: the points the purchase earned are taken back
   * but the balance never goes below zero (the shortfall is recorded), progress and unused rewards the purchase earned are revoked, and a reward
   * that was ALREADY handed over stays given and is flagged for review. Exactly one caller can win (conditional status change), and nothing is
   * deleted: the ledger gets a negative adjustment and the purchase event is marked reversed.
   */
  async reversePurchase(input: ReversePurchaseInput): Promise<PurchaseReversalResult> {
    return this.db.transaction((tx) => this.reversePurchaseIn(tx, input));
  }

  /**
   * LPC-10: exactly what reversePurchase would do, without doing it. It runs the real reversal inside a transaction that is always rolled back, so
   * the preview can never differ from the result, and nothing is written (no ledger row, status change, entitlement change or progress event).
   */
  async previewPurchaseReversal(input: ReversePurchaseInput): Promise<PurchaseReversalResult> {
    try {
      await this.db.transaction(async (tx) => {
        throw new PreviewComplete(await this.reversePurchaseIn(tx, input));
      });
    } catch (error) {
      if (error instanceof PreviewComplete) return error.result;
      throw error;
    }
    throw new AppError('Preview did not complete.', 500, 'PREVIEW_FAILED');
  }

  private async reversePurchaseIn(tx: Parameters<Parameters<Database['transaction']>[0]>[0], input: ReversePurchaseInput): Promise<PurchaseReversalResult> {
    const repos = createRepositories(tx);
    const [flipped] = await tx
      .update(loyaltyPurchaseEvents)
      .set({ paymentStatus: 'reversed' })
      .where(and(eq(loyaltyPurchaseEvents.id, input.purchaseEventId), eq(loyaltyPurchaseEvents.businessId, input.businessId), eq(loyaltyPurchaseEvents.paymentStatus, 'confirmed')))
      .returning({ id: loyaltyPurchaseEvents.id, loyaltyAccountId: loyaltyPurchaseEvents.loyaltyAccountId });
    if (!flipped) {
      const [existing] = await tx.select({ status: loyaltyPurchaseEvents.paymentStatus }).from(loyaltyPurchaseEvents).where(and(eq(loyaltyPurchaseEvents.id, input.purchaseEventId), eq(loyaltyPurchaseEvents.businessId, input.businessId))).limit(1);
      if (!existing) throw new AppError('Purchase not found.', 404, 'PURCHASE_NOT_FOUND');
      throw new AppError('This purchase was already reversed.', 409, 'PURCHASE_ALREADY_REVERSED');
    }
    const account = await repos.loyaltyAccounts.lockForUpdate(flipped.loyaltyAccountId, input.businessId);
    if (!account) throw new AppError('Loyalty account not found.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
    const [business] = await tx.select({ currency: businesses.defaultCurrency, timeZone: businesses.defaultTimezone }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');

    const earnedRows = await tx
      .select({ points: loyaltyTransactions.points, programId: loyaltyTransactions.programId, programVersion: loyaltyTransactions.programVersion })
      .from(loyaltyTransactions)
      .where(and(eq(loyaltyTransactions.purchaseEventId, input.purchaseEventId), eq(loyaltyTransactions.loyaltyAccountId, account.id), eq(loyaltyTransactions.type, 'purchase')));
    const pointsEarned = earnedRows.reduce((sum, row) => sum + row.points, 0);
    const pointsReversed = Math.max(0, Math.min(pointsEarned, account.points));
    const pointsShortfall = Math.max(0, pointsEarned) - pointsReversed;
    const origin = earnedRows.find((row) => row.programId !== null);
    if (pointsReversed > 0) {
      await this.applyEarning(repos, account, 'adjustment', -pointsReversed, {
        notes: `Reversal of purchase ${input.purchaseEventId}: ${input.reason}${pointsShortfall > 0 ? ` (${pointsShortfall} points could not be taken back: already spent)` : ''}`,
        createdBy: input.actorUserId,
        ...(origin?.programId && origin.programVersion !== null ? { provenance: { programId: origin.programId, programVersion: origin.programVersion } } : {}),
      });
    }
    const progress = await reversePurchaseProgress(tx, {
      businessId: input.businessId,
      loyaltyAccountId: account.id,
      purchaseEventId: input.purchaseEventId,
      timeZone: business.timeZone,
      currency: business.currency,
    });
    return { purchaseEventId: input.purchaseEventId, accountId: account.id, pointsEarned, pointsReversed, pointsShortfall, progress };
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

  async getSummary(
    customerId: string,
    businessId: string,
  ): Promise<LoyaltyAccountSummary | undefined> {
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

  private async requireEligibleEarningAccount(
    repos: Repositories,
    accountId: string,
    businessId: string,
  ) {
    // Read only to locate the relationship; acquire no account lock before the membership.
    const reference = await this.requireAccount(repos, accountId, businessId);
    const membership = await repos.customerMemberships.findByCustomerAndBusinessForShare(
      reference.customerId,
      businessId,
    );
    const account = await repos.loyaltyAccounts.lockForUpdate(accountId, businessId);
    if (account && account.customerId !== reference.customerId) {
      throw new AppError(
        'Loyalty membership mapping is inconsistent.',
        409,
        'MEMBERSHIP_MAPPING_CONFLICT',
      );
    }
    const decision = evaluateMembershipGate(membership, account, 'checkin');
    if (!decision.ok)
      throw new AppError(decision.refusal.message, decision.refusal.status, decision.refusal.code);
    return { membership: decision.membership, account: decision.account };
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
      provenance?: EarningProvenance | undefined;
      id?: string | undefined;
    },
  ): Promise<LoyaltyAccount> {
    let updated = await repos.loyaltyAccounts.applyPointsDelta(account.id, points, {
      recordVisit: extra.recordVisit,
    });

    const eligibleTier = await repos.loyaltyTiers.findHighestEligible(
      account.businessId,
      updated.points,
    );
    const eligibleTierId = eligibleTier?.id ?? null;
    if (eligibleTierId !== updated.tierId) {
      updated = await repos.loyaltyAccounts.updateTier(account.id, eligibleTierId);
    }

    await repos.loyaltyTransactions.create({
      ...(extra.id ? { id: extra.id } : {}),
      loyaltyAccountId: account.id,
      type,
      points,
      relatedQrCodeId: extra.relatedQrCodeId ?? null,
      visitSessionId: extra.visitSessionId ?? null,
      purchaseAmount: extra.purchaseAmount ?? null,
      purchaseEventId: extra.purchaseEventId ?? null,
      programId: extra.provenance?.programId ?? null,
      programVersion: extra.provenance?.programVersion ?? null,
      notes: extra.notes ?? null,
      createdBy: extra.createdBy ?? null,
    });

    return updated;
  }
}
