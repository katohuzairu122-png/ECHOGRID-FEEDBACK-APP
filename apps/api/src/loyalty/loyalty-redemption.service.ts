import type { Database } from '../db/client';
import { createRepositories } from '../repositories';
import type { LoyaltyTransaction, LoyaltyReward } from '../repositories';
import { AppError } from '../lib/errors';
import { generateRedemptionCode } from './redemption-code';
import { VisitSessionService } from '../visits/visit-session.service';

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

/** Continuing Development Block 2 (S6.1 limitPer='visit' + S6.4 minimum
 * feedback requirements -- both blocked on redeem()/issue() having no way to
 * receive a feedback/visit reference at all; see resolveRedemptionReferences'
 * own comment below). Shared by redeem() and issue(); every field optional
 * and defaulted to `{}` at both call sites, so an existing caller that
 * passes none of them is completely unaffected by this block. */
export interface RedemptionReferenceInput {
  feedbackId?: string | undefined;
  visitProof?: string | undefined;
  branchId?: string | undefined;
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

  /**
   * Continuing Development Block 6.4 (S5.8 "maximum rewards per day" /
   * "maximum campaign budget," enforced per S6.8 step 4, "check daily
   * limits and campaign budget"). Shared by issue() and redeem() -- both
   * need the identical lock-then-check sequence against the same two
   * columns, just at a different point in two otherwise-different methods.
   * Callers must call this AFTER their
   * own existence/status/type checks (it assumes `reward` is already known
   * good and already locked via loyaltyRewards.lockForUpdate) and BEFORE
   * their code-generation loop -- throwing here must happen before any
   * transaction row is created.
   *
   * maxBudget is compared against `reward.rewardValue`, which is null for
   * every 'points'-type reward (Block 6.1's own design: rewardValue is
   * additive alongside pointsCost, not a replacement) -- so this is a
   * deliberate no-op for points-type rewards even when a business sets
   * maxBudget on one, confirmed with the project owner rather than assumed.
   * A points reward is already limited by the customer's own balance, a
   * completely different mechanism; maxRewardsPerDay still applies to every
   * type, since it's just a count.
   */
  private async checkDailyAndBudgetLimits(
    repos: ReturnType<typeof createRepositories>,
    reward: LoyaltyReward,
  ): Promise<void> {
    if (reward.maxRewardsPerDay === null && reward.maxBudget === null) return;

    const { todayCount, totalCount } = await repos.loyaltyTransactions.countForLimitCheck(reward.id);

    if (reward.maxRewardsPerDay !== null && todayCount >= reward.maxRewardsPerDay) {
      throw new AppError('This reward has reached its daily limit.', 422, 'LOYALTY_REWARD_DAILY_LIMIT_REACHED');
    }
    if (reward.maxBudget !== null && reward.rewardValue !== null) {
      const projectedSpend = (totalCount + 1) * Number(reward.rewardValue);
      if (projectedSpend > Number(reward.maxBudget)) {
        throw new AppError('This reward has reached its budget.', 422, 'LOYALTY_REWARD_BUDGET_EXCEEDED');
      }
    }
  }

  /**
   * Continuing Development Block 6.5 (S5.5 "customer cooldown" + S6.1 "one
   * reward per receipt, visit or defined period" -- the `limitPer:
   * 'period'` case only, per S6.8 step 3, "check cooldown and fraud
   * signals"). Called BEFORE checkDailyAndBudgetLimits() (S6.8 step 4) in
   * both issue() and redeem(), matching the spec's own step ordering.
   * Shared by both methods, same lock-then-check shape as
   * checkDailyAndBudgetLimits() but scoped to ONE customer's own history
   * against this reward, not the whole campaign -- a separate method, not
   * folded into that one, since S6.8 lists them as two distinct steps and
   * this one needs loyaltyAccountId, which that one doesn't.
   *
   * cooldownSeconds and limitPer='period' both reduce to the same
   * question -- "how long since this customer's last claim of this
   * reward" -- so one lookup (findLastRedemptionForAccount) backs both
   * checks; they stay two separate thresholds/error codes rather than one
   * collapsed check, since a business can set either, both, or neither
   * independently, and the caller benefits from knowing which specific
   * rule was hit.
   *
   * No points-type exception here, unlike checkDailyAndBudgetLimits'
   * maxBudget arm -- cooldown/period-limit aren't tied to rewardValue, so
   * there's no analogous reason to skip them for a points-type reward;
   * both apply to every type, same as maxRewardsPerDay.
   *
   * limitPer 'receipt' and 'visit' are deliberately NOT enforced here --
   * disclosed gap, not an oversight, unlike every check added in Blocks
   * 6.3-6.5, which all enforce against data these methods already had.
   * Originally both would have needed receipt/visit-session identity
   * threaded into issue()/redeem()'s API contract first, which neither
   * method accepted at the time. Continuing Development Block 2 built that
   * threading for visit-session identity specifically (visitProof +
   * branchId, resolved via resolveRedemptionReferences() below into
   * visitSessionId on the created row) -- but deliberately did not also add
   * an enforcement check here, since checking it is a distinct, separately-
   * scoped concern from merely having it available to check. This method
   * still doesn't consult visitSessionId at all; a future block adds that
   * consultation. limitPer='receipt' has no threaded identity to check yet
   * either way -- no receipt/POS verification mechanism exists anywhere in
   * this codebase (visit-verification.ts's own doc comment), so that half
   * of this gap is unchanged and still not yet scoped in detail.
   */
  private async checkCooldownAndPeriodLimit(
    repos: ReturnType<typeof createRepositories>,
    reward: LoyaltyReward,
    loyaltyAccountId: string,
  ): Promise<void> {
    if (reward.cooldownSeconds === null && reward.limitPer !== 'period') return;

    const last = await repos.loyaltyTransactions.findLastRedemptionForAccount(reward.id, loyaltyAccountId);
    if (!last) return;

    const msSinceLast = Date.now() - last.createdAt.getTime();

    if (reward.cooldownSeconds !== null && msSinceLast < reward.cooldownSeconds * 1000) {
      throw new AppError('You must wait before claiming this reward again.', 422, 'LOYALTY_REWARD_COOLDOWN_ACTIVE');
    }
    if (reward.limitPer === 'period' && reward.limitPeriodDays !== null) {
      const periodMs = reward.limitPeriodDays * 24 * 60 * 60 * 1000;
      if (msSinceLast < periodMs) {
        throw new AppError(
          'This reward can only be claimed once per period.',
          422,
          'LOYALTY_REWARD_PERIOD_LIMIT_REACHED',
        );
      }
    }
  }

  /**
   * Continuing Development Block 2 (S6.1 limitPer='visit', S6.4 minimum
   * feedback requirements -- the plumbing prerequisite both need). Shared by
   * redeem() and issue(): resolves the two optional reference fields
   * redeemRewardSchema/issueRewardSchema now accept into what actually gets
   * persisted on the created loyalty_transactions row. Neither input is
   * required, and neither ever blocks the redemption/issuance. Enforcing
   * minCommentLength/requireVisitVerification/limitPer='visit' against what
   * gets resolved here is explicitly OUT of scope for this block -- this
   * method only threads the references through; a future block decides what
   * to require of them.
   *
   * feedbackId: validated for existence + tenant scope only
   * (FeedbackRepository.findById already checks both, plus isDeleted). An id
   * that doesn't resolve -- wrong business, deleted, or simply doesn't exist
   * -- is silently dropped (null, same as if the field had never been sent)
   * rather than failing the whole redemption over what could just as easily
   * be a stale client-side id as a deliberate spoof. Deliberately NOT logged
   * as a fraud signal, unlike visitProof below: an unresolved foreign-key
   * reference isn't one of this codebase's existing fraud-signal categories
   * (velocity, duplicate text, forged token, failed visit verification --
   * all abuse PATTERNS, not "this id didn't resolve"), and inventing a new
   * one here would be scope beyond what this block was asked to do ("thread
   * a reference"). A real abuse pattern around this, if one shows up, is a
   * separately-scoped detector, not a silent addition to this method.
   *
   * visitProof + branchId: mirrors loyalty-customer.routes.ts's own inline
   * check-in verification block exactly -- same VisitSessionService.verify()
   * call, same fraud signal on failure, same advisory-only "never blocks"
   * outcome. Duplicated rather than extracted into a helper shared across
   * both files, matching how checkDailyAndBudgetLimits/
   * checkCooldownAndPeriodLimit above are this file's own local private
   * helpers rather than reaching into another module. branchId is REQUIRED
   * alongside visitProof (enforced by the shared-types .refine(), defense-in-
   * depth guarded again below) because redeem()/issue() have no QR scan to
   * resolve a branchId from the way checkin/feedback do -- there is no
   * server-derived branchId to fall back on here, so the client must say
   * which branch it's claiming the reward at. A wrong/foreign branchId isn't
   * separately rejected -- VisitSessionService.verify() already returns
   * verified: false for a session that doesn't belong to the given
   * businessId/branchId (see that method's own "defense in depth" comment),
   * so it naturally falls into the same advisory-failure path as an
   * invalid/expired proof.
   */
  private async resolveRedemptionReferences(
    repos: ReturnType<typeof createRepositories>,
    businessId: string,
    input: RedemptionReferenceInput,
  ): Promise<{ feedbackId: string | null; visitSessionId: string | null }> {
    let feedbackId: string | null = null;
    if (input.feedbackId) {
      const feedbackRow = await repos.feedback.findById(input.feedbackId, businessId);
      if (feedbackRow) feedbackId = feedbackRow.id;
    }

    let visitSessionId: string | null = null;
    if (input.visitProof && input.branchId) {
      const verification = await new VisitSessionService(repos).verify(businessId, input.branchId, input.visitProof);
      if (verification.verified) {
        const sessionId = verification.metadata?.sessionId;
        visitSessionId = typeof sessionId === 'string' ? sessionId : null;
      } else {
        await repos.fraudSignals.create({
          businessId,
          branchId: input.branchId,
          feedbackId: null,
          signalType: 'visit_verification',
          reasonCode: verification.reasonCode ?? 'invalid_or_expired',
          severity: 'low',
          metadata: { proof: input.visitProof },
        });
      }
    }

    return { feedbackId, visitSessionId };
  }

  async redeem(
    customerId: string,
    businessId: string,
    rewardId: string,
    references: RedemptionReferenceInput = {},
  ): Promise<RedemptionResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
      if (!account) {
        throw new AppError('You are not enrolled in this loyalty program yet.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
      }

      // lockForUpdate, not findById, since Block 6.4: this row's lock is
      // held for the rest of this transaction, serializing any concurrent
      // redeem()/issue() against the SAME reward until this one commits or
      // rolls back -- see that method's own doc comment. Identical shape/
      // filters to findById otherwise, so this is behavior-preserving for
      // every existing check below.
      const reward = await repos.loyaltyRewards.lockForUpdate(rewardId, businessId);
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

      await this.checkCooldownAndPeriodLimit(repos, reward, account.id);
      await this.checkDailyAndBudgetLimits(repos, reward);

      if (account.points < reward.pointsCost) {
        throw new AppError('Not enough points for this reward.', 422, 'INSUFFICIENT_POINTS');
      }

      // Continuing Development Block 2 -- resolved after every blocking
      // guard above has passed (matches checkDailyAndBudgetLimits' own
      // "throwing must happen before any transaction row is created"
      // ordering), so a redemption that was always going to fail on
      // cooldown/budget/points never pays for a feedback lookup or a visit-
      // session verification call it won't use.
      const refs = await this.resolveRedemptionReferences(repos, businessId, references);

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
          feedbackId: refs.feedbackId,
          visitSessionId: refs.visitSessionId,
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
   * Originally shipped enforcing none of branchId / maxBudget /
   * maxRewardsPerDay / cooldownSeconds / limitPer -- deliberately, a known
   * disclosed gap, not an oversight. Since closed incrementally: Block 6.3
   * added branch eligibility (checked at confirmRedemption(), not here --
   * see that method's own comment for why), Block 6.4 added
   * maxRewardsPerDay and maxBudget (checkDailyAndBudgetLimits(), below),
   * Block 6.5 added cooldownSeconds and the limitPer='period' case
   * (checkCooldownAndPeriodLimit(), above).
   *
   * limitPer='receipt'/'visit' remain UNENFORCED here -- still a known,
   * disclosed gap -- but Continuing Development Block 2 corrected the
   * now-stale reason given for that: visit identity (a customer-supplied
   * visitProof + branchId, verified via VisitSessionService, same as
   * check-in) IS now part of this method's contract, threaded through via
   * resolveRedemptionReferences() above and persisted as visitSessionId on
   * the created row. What Block 2 deliberately did NOT do is check that
   * value against limitPer='visit' or reject a call that omits it --
   * enforcement is a separate future block's scope, this one only threads
   * the reference. limitPer='receipt' has no comparable path at all: no
   * receipt/POS verification mechanism exists anywhere in this codebase
   * (visit-verification.ts's own doc comment), so there is still nothing
   * for a client to even supply -- that gap is unchanged by this block.
   * Separately: every campaign field Blocks 6.1-6.4 added is enforceable
   * here but not yet SETTABLE through the real API -- LoyaltyRewardService's
   * CreateRewardInput/UpdateRewardInput only expose name/pointsCost/
   * description(+status) -- see Block 6.9's own completion notes for why
   * that's a separate, proposed next block rather than folded into this
   * one.
   */
  async issue(
    customerId: string,
    businessId: string,
    rewardId: string,
    references: RedemptionReferenceInput = {},
  ): Promise<IssuanceResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId);
      if (!account) {
        throw new AppError('You are not enrolled in this loyalty program yet.', 404, 'LOYALTY_ACCOUNT_NOT_FOUND');
      }

      // lockForUpdate, not findById -- see redeem()'s identical comment on
      // this same call, and checkDailyAndBudgetLimits' own doc comment.
      const reward = await repos.loyaltyRewards.lockForUpdate(rewardId, businessId);
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

      await this.checkCooldownAndPeriodLimit(repos, reward, account.id);
      await this.checkDailyAndBudgetLimits(repos, reward);

      // Continuing Development Block 2 -- see redeem()'s identical call for
      // why this runs here, after every blocking guard above.
      const refs = await this.resolveRedemptionReferences(repos, businessId, references);

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
          feedbackId: refs.feedbackId,
          visitSessionId: refs.visitSessionId,
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
