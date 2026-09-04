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

/** Continuing Development Block 3 -- resolveRedemptionReferences' own
 * return shape, pulled out as a named type once a second and third caller
 * (checkMinimumFeedbackRequirements, checkVisitLimit below) needed to
 * accept it too, rather than repeating the same inline object-literal
 * type three times. */
interface ResolvedRedemptionReferences {
  feedbackId: string | null;
  visitSessionId: string | null;
  feedbackComment: string | null;
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
   * scoped concern from merely having it available to check.
   *
   * Continuing Development Block 3 closed the limitPer='visit' half, in a
   * NEW sibling method, checkVisitLimit() below, rather than by teaching
   * THIS method to also consult visitSessionId -- see checkVisitLimit's own
   * comment for why it doesn't reduce to the same "time since last claim"
   * question cooldownSeconds/limitPer='period' share, which is the whole
   * reason those two live in one method together. This method itself is
   * otherwise unchanged by Block 3. limitPer='receipt' still has no
   * threaded identity to check -- no receipt/POS verification mechanism
   * exists anywhere in this codebase (visit-verification.ts's own doc
   * comment), so that half of the original gap is unchanged and still not
   * yet scoped in detail.
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
   * required, and this method itself never blocks the redemption/issuance --
   * that remains true after Block 3. Enforcing
   * minCommentLength/requireVisitVerification/limitPer='visit' against what
   * gets resolved here was explicitly OUT of scope for Block 2 -- that
   * block only threaded the references through. Continuing Development
   * Block 3 is the future block referenced above: it added
   * checkMinimumFeedbackRequirements() and checkVisitLimit() (both below,
   * called from redeem()/issue() right after this method resolves their
   * input), which enforce those three rules against exactly what gets
   * resolved here. This method grew one new field on its return value
   * (feedbackComment, so the new minCommentLength check doesn't need a
   * second feedback lookup) but its own resolution behavior is otherwise
   * unchanged -- see feedbackId/visitProof's own paragraphs below, both
   * still accurate as written.
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
  ): Promise<ResolvedRedemptionReferences> {
    let feedbackId: string | null = null;
    let feedbackComment: string | null = null;
    if (input.feedbackId) {
      const feedbackRow = await repos.feedback.findById(input.feedbackId, businessId);
      if (feedbackRow) {
        feedbackId = feedbackRow.id;
        feedbackComment = feedbackRow.comment;
      }
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

    return { feedbackId, visitSessionId, feedbackComment };
  }

  /**
   * Continuing Development Block 3 (S6.4 "minimum feedback requirements" --
   * the enforcement resolveRedemptionReferences' own doc comment named as
   * explicitly out of scope for Block 2, and checkCooldownAndPeriodLimit's
   * own doc comment named as a future block's job). Two independent gates,
   * both fail closed per S2.16 ("fail closed... when eligibility... cannot
   * complete") rather than treating "can't verify" as "passes":
   *
   * minCommentLength: requires a resolved feedbackId (see
   * resolveRedemptionReferences above) whose feedback.comment is at least
   * minCommentLength characters after trimming. No feedbackId resolved at
   * all -- omitted, or supplied but didn't resolve (wrong business,
   * deleted, doesn't exist; resolveRedemptionReferences already silently
   * drops those to null rather than rejecting there, since an unresolved
   * id wasn't blocking in Block 2) -- is treated identically to "comment
   * too short," since there's no comment to measure either way.
   *
   * DISCLOSED LIMITATION, not silently glossed over: feedback submission
   * is deliberately anonymous -- no customerId/loyaltyAccountId column
   * exists on the feedback table at all (feedback.ts's own doc comment;
   * Block 6.9's Option A/B decision explicitly refused to weaken this).
   * There is therefore no structural way to verify a supplied feedbackId
   * was actually written by the customer redeeming right now, as opposed
   * to any other customer's feedback at the same business --
   * resolveRedemptionReferences only ever checks existence + tenant scope
   * (Block 2), because ownership isn't a checkable fact in this schema.
   * In practice this makes minCommentLength closer to an honor-system
   * content nudge than an airtight guarantee: a customer who knows or is
   * handed a long-enough feedbackId from the same business can satisfy
   * this gate without having written a word of it themselves. Closing
   * this for real would need a new correlation mechanism (e.g. a
   * short-lived signed token handed back at feedback-submission time and
   * required again at redeem time, proving "same browser session," not
   * "same real person") -- a separately-scoped feature this block does
   * not invent unasked, per S2's "do not invent APIs." requireVisitVerification
   * below does NOT share this weakness -- see its own paragraph.
   *
   * requireVisitVerification: requires visitSessionId to be non-null (set
   * only when resolveRedemptionReferences' own VisitSessionService.verify()
   * call returned verified: true) -- omitted, or supplied but failed
   * verification, are indistinguishable here, matching
   * resolveRedemptionReferences' own enumeration-resistant design (both
   * already collapse to visitSessionId staying null there). Unlike a
   * feedbackId, a visitProof requires possession of an actual staff-issued
   * code that VisitSessionService.verify() consumes atomically (single-use)
   * or scopes to one active session (table session) -- not a
   * guessable/reusable identifier -- so this gate does not share
   * minCommentLength's ownership weakness above.
   *
   * No repository access needed -- everything here was already fetched by
   * resolveRedemptionReferences, so this stays synchronous rather than
   * manufacturing an unnecessary Promise.
   */
  private checkMinimumFeedbackRequirements(reward: LoyaltyReward, refs: ResolvedRedemptionReferences): void {
    if (reward.minCommentLength !== null) {
      // feedbackComment is only ever non-null when feedbackId also resolved
      // (resolveRedemptionReferences sets both together or neither), so
      // this one expression correctly covers "no feedback reference at
      // all" and "resolved but comment is NULL/empty" alike -- both are 0.
      const commentLength = (refs.feedbackComment ?? '').trim().length;
      if (commentLength < reward.minCommentLength) {
        throw new AppError(
          `This reward requires feedback with a comment of at least ${reward.minCommentLength} characters.`,
          422,
          'LOYALTY_REWARD_COMMENT_TOO_SHORT',
        );
      }
    }

    if (reward.requireVisitVerification && refs.visitSessionId === null) {
      throw new AppError('This reward requires a verified visit to claim.', 422, 'LOYALTY_REWARD_VISIT_REQUIRED');
    }
  }

  /**
   * Continuing Development Block 3 (S6.1 "one reward per visit," the
   * limitPer='visit' case checkCooldownAndPeriodLimit's own doc comment
   * named as a future block's job). Deliberately NOT folded into
   * checkCooldownAndPeriodLimit above: that method's own justification for
   * merging cooldownSeconds/limitPer='period' into one lookup is that both
   * reduce to "how long since this customer's last claim" --
   * limitPer='visit' doesn't reduce to that question at all (it's "has
   * THIS SPECIFIC visit already claimed this reward," an existence check
   * against one id, not a recency comparison against a timestamp), so
   * folding it in would undercut that method's own stated reason for being
   * one method instead of two.
   *
   * Fails closed when limitPer='visit' but no visitSessionId resolved (no
   * visitProof supplied, or it failed verification) -- per S2.16, there is
   * no visit identity to scope a "one per visit" rule against, so letting
   * the claim through would silently mean "unlimited" instead of enforcing
   * anything. This makes limitPer='visit' functionally also require a
   * verified visit, independent of and in addition to the separate
   * requireVisitVerification flag checked in
   * checkMinimumFeedbackRequirements above -- a business can set either,
   * both (redundant, harmless), or neither. Both paths share the
   * LOYALTY_REWARD_VISIT_REQUIRED code: from the client's point of view the
   * remedy is identical either way ("supply a valid visitProof +
   * branchId"), and the reward's own config (already visible via
   * GET /rewards) already explains which rule is asking for it.
   *
   * Scoped by (rewardId, loyaltyAccountId, visitSessionId), matching
   * findCheckinByVisitSession's (Block 5.2) account+session pairing --
   * blocks the SAME account from claiming the SAME reward twice on one
   * visit, but a different account sharing the same table-session code can
   * still claim it once, same reasoning Block 5.2 established for check-in
   * dedup on a shared code. Also scoped by rewardId (unlike
   * findCheckinByVisitSession, since check-in has no reward concept) so
   * two different limitPer='visit' rewards stay independently claimable on
   * the same visit, matching S6.1's own per-campaign framing of this
   * limit.
   *
   * Concurrency note: this method's own existence check is not itself the
   * race-safe backstop -- two concurrent claims of the SAME reward on the
   * SAME visit are serialized by the reward row lock redeem()/issue()
   * already hold via loyaltyRewards.lockForUpdate() (same reliance
   * checkCooldownAndPeriodLimit/checkDailyAndBudgetLimits above already
   * have on that same lock, not a new assumption this method introduces).
   */
  private async checkVisitLimit(
    repos: ReturnType<typeof createRepositories>,
    reward: LoyaltyReward,
    loyaltyAccountId: string,
    visitSessionId: string | null,
  ): Promise<void> {
    if (reward.limitPer !== 'visit') return;

    if (visitSessionId === null) {
      throw new AppError('This reward requires a verified visit to claim.', 422, 'LOYALTY_REWARD_VISIT_REQUIRED');
    }

    const existing = await repos.loyaltyTransactions.findRedemptionByVisitSession(
      reward.id,
      loyaltyAccountId,
      visitSessionId,
    );
    if (existing) {
      throw new AppError(
        'This reward has already been claimed for this visit.',
        422,
        'LOYALTY_REWARD_VISIT_LIMIT_REACHED',
      );
    }
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

      // Continuing Development Block 3 -- both gate on data refs just
      // resolved, so they run immediately after it, same reasoning as
      // resolveRedemptionReferences' own positioning here: a call that was
      // always going to fail for an unrelated reason (cooldown/budget/
      // points, all checked above) never pays for these checks either.
      this.checkMinimumFeedbackRequirements(reward, refs);
      await this.checkVisitLimit(repos, reward, account.id, refs.visitSessionId);

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
   * limitPer='visit' was UNENFORCED through Block 2 -- that block only
   * threaded visit identity (a customer-supplied visitProof + branchId,
   * verified via VisitSessionService, same as check-in) into this method's
   * contract via resolveRedemptionReferences() above, persisted as
   * visitSessionId on the created row, without checking that value against
   * limitPer='visit' or requireVisitVerification. Continuing Development
   * Block 3 closed both: checkMinimumFeedbackRequirements() enforces
   * requireVisitVerification (plus minCommentLength, S6.4's other
   * "minimum feedback requirement"), checkVisitLimit() enforces
   * limitPer='visit' -- both called right after resolveRedemptionReferences()
   * below, see their own doc comments. limitPer='receipt' still has no
   * comparable path: no receipt/POS verification mechanism exists anywhere
   * in this codebase (visit-verification.ts's own doc comment), so there
   * is still nothing for a client to even supply -- that half of the gap
   * is unchanged.
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

      // Continuing Development Block 3 -- see redeem()'s identical pair of
      // calls for why these run here, right after refs resolves.
      this.checkMinimumFeedbackRequirements(reward, refs);
      await this.checkVisitLimit(repos, reward, account.id, refs.visitSessionId);

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
