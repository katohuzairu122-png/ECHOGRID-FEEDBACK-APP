import type { Repositories, LoyaltyReward } from '../repositories';
import { AppError } from '../lib/errors';

/** Rounds a currency amount to 2 decimal places -- guards
 * getCampaignDashboard()'s totalCount/outstandingCount * rewardValue
 * multiplications against a plain floating-point artifact (e.g. 3 * 9.10
 * in IEEE 754 doubles). Local to this file: nothing else in the service
 * layer does arithmetic on a converted numeric column today, so there's
 * no existing shared helper this could reuse instead of adding one. */
function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

type RewardType = 'points' | 'discount' | 'free_item' | 'voucher';
type RewardLimitPer = 'receipt' | 'visit' | 'period';

/** Block 6.1's ten campaign fields (the "config-API gap" closed this
 * block), shared between create and update so neither interface repeats
 * them. Matches createRewardSchema/updateRewardSchema's own shared
 * `rewardCampaignFields` spread in packages/shared-types/src/loyalty.ts --
 * keep the two in sync.
 *
 * Six of the ten accept an explicit `null` (clear this field back to
 * "unset"), not just omission ("leave it alone"): branchId (Block 6.8.1)
 * and, as of Block 6.8.3, maxRewardsPerDay/maxBudget/limitPer/
 * limitPeriodDays/cooldownSeconds. Each was widened the same way, for the
 * same reason -- a genuine standalone setting the staff UI's edit form
 * needs to be able to remove, where an omitted key can only mean "don't
 * touch." The remaining four -- type, rewardValue, startDate, expiryDate
 * -- stay omission-only: no UI need has come up yet to actively clear any
 * of them back to NULL (rewardValue/pointsCost instead go inert-but-
 * harmless when `type` changes away from what made them meaningful, see
 * RewardFormDialog's own comment), not an oversight, just unneeded so
 * far. */
interface RewardCampaignFields {
  branchId?: string | null | undefined;
  type?: RewardType | undefined;
  rewardValue?: number | undefined;
  startDate?: string | undefined;
  expiryDate?: string | undefined;
  maxRewardsPerDay?: number | null | undefined;
  maxBudget?: number | null | undefined;
  limitPer?: RewardLimitPer | null | undefined;
  limitPeriodDays?: number | null | undefined;
  cooldownSeconds?: number | null | undefined;
}

/** create()'s shape -- matches createRewardSchema exactly. Its cross-field
 * rules (pointsCost required for a points-type reward, limitPeriodDays
 * required when limitPer='period', expiryDate after startDate) are
 * validated by that schema at the route layer before this is ever called;
 * this interface only needs to describe the shape. */
export interface CreateRewardInput extends RewardCampaignFields {
  name: string;
  description?: string | undefined;
  pointsCost?: number | undefined;
}

/** update()'s shape -- matches updateRewardSchema exactly (every field
 * optional, plus status widened to include 'paused': Block 6.1 added it
 * to the DB CHECK but nothing could set it through the API until now). */
export interface UpdateRewardInput extends RewardCampaignFields {
  name?: string | undefined;
  description?: string | undefined;
  pointsCost?: number | undefined;
  status?: 'active' | 'inactive' | 'paused' | undefined;
}

/** Block 6.7.1 (S6.3 campaign dashboard) -- getCampaignDashboard()'s return
 * shape. Deliberately a plain interface here, not yet a shared-types Zod
 * schema: Block 6.7.1 is backend-only (repository + service), no route.
 * Block 6.7.2 adds the JSON-response DTO and is expected to mirror this
 * shape, the same way RedemptionResult (this module) and
 * redemptionResultSchema (shared-types) already coexist as two
 * independently-defined, shape-compatible types rather than one importing
 * the other.
 *
 * budgetUsed/budgetRemaining/outstandingLiability are `number | null`, not
 * the decimal-string convention loyaltyRewardSchema uses for rewardValue/
 * maxBudget -- that convention exists for the numeric column's own
 * Drizzle round-trip; these three are computed here, not stored, so there
 * is no column type to match. Whether the eventual response DTO re-adopts
 * the string convention for consistency with the rest of the reward
 * payload is a Block 6.7.2 decision, not assumed here.
 *
 * Every money/rate field below is `null`, not `0`, whenever it isn't
 * meaningful for this specific reward -- never a fabricated zero. */
export interface CampaignDashboard {
  reward: LoyaltyReward;
  /** Block 6.7.3 (S6.3 "branch scope") -- resolved server-side via
   * this.repos.branches (already a dependency since Block 6.6's branch-
   * scoping validation), NOT a second client-side call to GET
   * /branches/:id. That route requires branches:view -- a permission this
   * dashboard's own loyalty:view gate does not guarantee a caller also
   * holds (checked against role-permissions-backfill.seed.ts before
   * choosing this design, not assumed) -- so resolving it here means
   * anyone who can see this dashboard always sees a real branch name,
   * never a permission error on a field they never asked to fetch
   * separately. Null exactly when reward.branchId is null (business-
   * wide), the same "null branchId = any branch" convention already
   * established elsewhere (see LoyaltyRedemptionService.confirmRedemption's
   * own comment). Also null if branchId is set but the branch itself was
   * since deleted -- a dangling reference shouldn't break a read-only
   * dashboard. */
  branchName: string | null;
  stats: {
    totalCount: number;
    outstandingCount: number;
    redeemedCount: number;
    /** null when totalCount is 0 -- no redemption activity yet is a
     * different fact than "0% convert," and S8.1's own warning against
     * misleading figures on too small a sample applies here too. */
    redemptionRate: number | null;
    /** reward.maxBudget as a plain number. Null when this campaign has no
     * budget cap set. */
    budgetTotal: number | null;
    /** totalCount * reward.rewardValue -- the same math
     * LoyaltyRedemptionService.checkDailyAndBudgetLimits() already
     * enforces against (minus that method's own "+1": this reports spend
     * so far, not a next-attempt projection), reused rather than a second
     * formula that could drift from what enforcement actually does. Null
     * for a 'points'-type reward: rewardValue is never set for that type
     * (Block 6.1's design -- a points reward spends the account's own
     * point balance, not a currency amount), the same condition
     * checkDailyAndBudgetLimits already treats as a deliberate no-op for
     * maxBudget enforcement. Rounded to 2dp via roundMoney(). */
    budgetUsed: number | null;
    /** budgetTotal - budgetUsed. Null whenever either side is null -- a
     * points-type reward, or a campaign with no budget cap set, has
     * nothing meaningful to report as "remaining." */
    budgetRemaining: number | null;
    /** outstandingCount * reward.rewardValue -- what's still owed if
     * every outstanding (issued-but-not-yet-confirmed) redemption gets
     * confirmed. Same points-type null rule as budgetUsed, and
     * deliberately NOT extended to points-type rewards via pointsCost
     * instead: a points redemption already debits the account's balance
     * at redeem() time (see LoyaltyRedemptionService.redeem()), before
     * confirmation -- the business owes nothing further once redeem() has
     * run, so there is no real liability left to report for that type, in
     * either unit. */
    outstandingLiability: number | null;
  };
}

/** Reward catalog configuration (rewards:manage) -- mirrors LoyaltyTierService's shape. */
export class LoyaltyRewardService {
  constructor(
    private readonly repos: Pick<Repositories, 'loyaltyRewards' | 'branches' | 'loyaltyTransactions'>,
  ) {}

  /** Customer-facing catalog and the staff config screen both call this;
   * `includeInactive` distinguishes the two (see repository doc comment). */
  async list(businessId: string, options: { includeInactive?: boolean } = {}): Promise<LoyaltyReward[]> {
    return this.repos.loyaltyRewards.listForBusiness(businessId, options);
  }

  async create(
    businessId: string,
    input: CreateRewardInput,
    createdBy: string,
  ): Promise<LoyaltyReward> {
    await this.assertBranchBelongsToBusiness(input.branchId, businessId);
    return this.repos.loyaltyRewards.create({
      businessId,
      name: input.name,
      description: input.description,
      pointsCost: input.pointsCost,
      createdBy,
      ...this.convertCampaignFields(input),
    });
  }

  async update(
    id: string,
    businessId: string,
    patch: UpdateRewardInput,
    updatedBy: string,
  ): Promise<LoyaltyReward> {
    await this.assertBranchBelongsToBusiness(patch.branchId, businessId);
    const reward = await this.repos.loyaltyRewards.update(
      id,
      businessId,
      {
        name: patch.name,
        description: patch.description,
        pointsCost: patch.pointsCost,
        status: patch.status,
        ...this.convertCampaignFields(patch),
      },
      updatedBy,
    );
    if (!reward) throw new AppError('Reward not found.', 404, 'LOYALTY_REWARD_NOT_FOUND');
    return reward;
  }

  async remove(id: string, businessId: string, deletedBy: string): Promise<void> {
    const existing = await this.repos.loyaltyRewards.findById(id, businessId);
    if (!existing) throw new AppError('Reward not found.', 404, 'LOYALTY_REWARD_NOT_FOUND');
    await this.repos.loyaltyRewards.softDelete(id, businessId, deletedBy);
  }

  /** Continuing Development Block 6.7.1 (S6.3 campaign dashboard). Combines
   * one reward row with LoyaltyTransactionRepository.getCampaignStats()'s
   * counts into the shape a staff dashboard needs -- see CampaignDashboard
   * above for what each field means and why some go null. Backend-only for
   * this block: no route calls this yet (Block 6.7.2), so nothing outside
   * this class's own test suite exercises it until then. */
  async getCampaignDashboard(id: string, businessId: string): Promise<CampaignDashboard> {
    const reward = await this.repos.loyaltyRewards.findById(id, businessId);
    if (!reward) throw new AppError('Reward not found.', 404, 'LOYALTY_REWARD_NOT_FOUND');

    const [{ totalCount, redeemedCount, outstandingCount }, branch] = await Promise.all([
      this.repos.loyaltyTransactions.getCampaignStats(id),
      reward.branchId ? this.repos.branches.findById(reward.branchId, businessId) : Promise.resolve(undefined),
    ]);
    const branchName = branch?.name ?? null;

    const rewardValue = reward.rewardValue !== null ? Number(reward.rewardValue) : null;
    const budgetTotal = reward.maxBudget !== null ? Number(reward.maxBudget) : null;
    const budgetUsed = rewardValue !== null ? roundMoney(totalCount * rewardValue) : null;
    const budgetRemaining =
      budgetTotal !== null && budgetUsed !== null ? roundMoney(budgetTotal - budgetUsed) : null;
    const outstandingLiability = rewardValue !== null ? roundMoney(outstandingCount * rewardValue) : null;
    const redemptionRate = totalCount > 0 ? redeemedCount / totalCount : null;

    return {
      reward,
      branchName,
      stats: {
        totalCount,
        outstandingCount,
        redeemedCount,
        redemptionRate,
        budgetTotal,
        budgetUsed,
        budgetRemaining,
        outstandingLiability,
      },
    };
  }

  /** A branch-scoped reward must be scoped to a branch that actually
   * belongs to this business -- same tenant-isolation pattern
   * summary.service.ts already uses for an optional branchId. No-op when
   * branchId isn't provided (business-wide reward, or an update that
   * doesn't touch branch scoping) -- new for this service, not a new
   * pattern for the codebase. Also no-op for an explicit `null` (Block
   * 6.8.1's "clear back to business-wide" case): nothing to validate when
   * the caller is deliberately un-scoping, not setting a branch. */
  private async assertBranchBelongsToBusiness(
    branchId: string | null | undefined,
    businessId: string,
  ): Promise<void> {
    if (!branchId) return;
    const branch = await this.repos.branches.findById(branchId, businessId);
    if (!branch) throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');
  }

  /** Shared by create() and update() so the numeric/date conversions live
   * in exactly one place. rewardValue/maxBudget: plain number in,
   * fixed-2-decimal string out -- the `numeric` column's insert type,
   * same conversion loyalty-account.service.ts already does for
   * purchaseAmount. startDate/expiryDate: ISO string in, Date out -- same
   * conversion feedback.repository.ts already does for dateFrom/dateTo.
   * A field left out of `input` stays `undefined` here too, which
   * Drizzle's insert/update builders treat as "don't touch this column"
   * -- never coerced to `null`, so a partial update never silently clears
   * a field it wasn't asked to change.
   *
   * Six fields can also arrive as an explicit `null` (see
   * RewardCampaignFields' own comment above for which, and why) -- every
   * one except maxBudget is a plain passthrough below, since Drizzle
   * already writes an explicit `null` as a real column NULL, distinct
   * from `undefined`'s "don't touch." maxBudget needs its own three-way
   * check instead of the same `!== undefined` guard rewardValue uses:
   * `null.toFixed(2)` throws, so copying that guard as-is would crash on
   * exactly the "clear the budget cap" case Block 6.8.3 exists to
   * support, not just fail to convert it. */
  private convertCampaignFields(input: RewardCampaignFields) {
    return {
      branchId: input.branchId,
      type: input.type,
      rewardValue: input.rewardValue !== undefined ? input.rewardValue.toFixed(2) : undefined,
      startDate: input.startDate !== undefined ? new Date(input.startDate) : undefined,
      expiryDate: input.expiryDate !== undefined ? new Date(input.expiryDate) : undefined,
      maxRewardsPerDay: input.maxRewardsPerDay,
      maxBudget:
        input.maxBudget === undefined ? undefined : input.maxBudget === null ? null : input.maxBudget.toFixed(2),
      limitPer: input.limitPer,
      limitPeriodDays: input.limitPeriodDays,
      cooldownSeconds: input.cooldownSeconds,
    };
  }
}
