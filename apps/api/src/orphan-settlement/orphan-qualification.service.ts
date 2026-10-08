import type { Database } from '../db/client';
import { createRepositories, type OrphanRewardClaim, type OrphanSettlementEvent } from '../repositories';
import { AppError } from '../lib/errors';
import type { OrphanReason, OrphanSourceRewardType } from '../db/schema';

export interface OrphanQualificationInput {
  sourceTransactionId: string;
  customerId: string;
  originBusinessId: string;
  orphanReason: OrphanReason;
  actorUserId?: string;
}

export interface OrphanQualificationResult {
  claim: OrphanRewardClaim;
  event: OrphanSettlementEvent;
  changed: boolean;
}

const SOURCE_REWARD_TYPES = new Set<OrphanSourceRewardType>([
  'discount',
  'free_item',
  'voucher',
]);

export class OrphanQualificationService {
  constructor(private readonly db: Database) {}

  async qualify(input: OrphanQualificationInput): Promise<OrphanQualificationResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const source = await repos.loyaltyTransactions.lockForUpdate(
        input.sourceTransactionId,
      );

      if (!source) {
        throw new AppError(
          'The source loyalty transaction does not exist.',
          404,
          'ORPHAN_SOURCE_NOT_FOUND',
        );
      }

      if (
        source.type !== 'redemption' ||
        source.issuanceStatus !== 'issued' ||
        source.redemptionConfirmedAt !== null ||
        source.relatedRewardId === null
      ) {
        throw new AppError(
          'The source transaction is not an outstanding issued reward entitlement.',
          409,
          'ORPHAN_SOURCE_NOT_OUTSTANDING',
        );
      }

      const account = await repos.loyaltyAccounts.findById(
        source.loyaltyAccountId,
        input.originBusinessId,
      );
      if (
        !account ||
        account.customerId !== input.customerId ||
        account.businessId !== input.originBusinessId
      ) {
        throw new AppError(
          'The asserted customer/business does not own the source entitlement.',
          409,
          'ORPHAN_SOURCE_MAPPING_MISMATCH',
        );
      }

      const business = await repos.businesses.findById(input.originBusinessId);
      if (!business) {
        throw new AppError(
          'The origin business does not exist.',
          404,
          'ORPHAN_ORIGIN_BUSINESS_NOT_FOUND',
        );
      }

      await this.assertOrphaningCondition(repos, input, business.status);

      const reward = await repos.loyaltyRewards.findById(
        source.relatedRewardId,
        input.originBusinessId,
      );
      if (!reward) {
        throw new AppError(
          'The source reward cannot be resolved for the origin business.',
          409,
          'ORPHAN_SOURCE_REWARD_MISMATCH',
        );
      }

      if (!SOURCE_REWARD_TYPES.has(reward.type as OrphanSourceRewardType)) {
        throw new AppError(
          'Raw points rewards are not eligible for orphan settlement.',
          409,
          'ORPHAN_SOURCE_REWARD_TYPE_INVALID',
        );
      }

      if (reward.expiryDate && reward.expiryDate <= new Date()) {
        throw new AppError(
          'The issued reward entitlement has expired.',
          409,
          'ORPHAN_SOURCE_REWARD_EXPIRED',
        );
      }

      const claimInput = {
        customerId: input.customerId,
        originBusinessId: input.originBusinessId,
        ...(account.membershipId !== null
          ? { originMembershipId: account.membershipId }
          : {}),
        originLoyaltyAccountId: account.id,
        originLoyaltyTransactionId: source.id,
        originRewardId: reward.id,
        orphanReason: input.orphanReason,
        status: 'available' as const,
        sourceRewardType: reward.type as OrphanSourceRewardType,
        sourceRewardSnapshot: {
          rewardName: reward.name,
          rewardType: reward.type,
          description: reward.description,
          rewardValue: reward.rewardValue,
          branchId: reward.branchId,
          startDate: reward.startDate?.toISOString() ?? null,
          expiryDate: reward.expiryDate?.toISOString() ?? null,
          issuedAt: source.createdAt.toISOString(),
        },
      };

      const claimResult = await repos.orphanRewardClaims.createIdempotent(claimInput);
      this.assertClaimReplayMatches(claimResult.claim, claimInput);

      const eventResult = await repos.orphanSettlementEvents.appendIdempotent({
        claimId: claimResult.claim.id,
        customerId: input.customerId,
        eventType: 'orphan_created',
        originBusinessId: input.originBusinessId,
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        idempotencyKey: `orphan-created:${source.id}`,
        metadata: {
          sourceTransactionId: source.id,
          orphanReason: input.orphanReason,
          sourceRewardType: reward.type,
        },
      });

      if (
        eventResult.event.claimId !== claimResult.claim.id ||
        eventResult.event.customerId !== input.customerId ||
        eventResult.event.originBusinessId !== input.originBusinessId ||
        eventResult.event.eventType !== 'orphan_created'
      ) {
        throw new AppError(
          'The orphan-created event idempotency key conflicts with another event.',
          409,
          'ORPHAN_EVENT_IDEMPOTENCY_CONFLICT',
        );
      }

      return {
        claim: claimResult.claim,
        event: eventResult.event,
        changed: claimResult.inserted || eventResult.inserted,
      };
    });
  }

  private async assertOrphaningCondition(
    repos: ReturnType<typeof createRepositories>,
    input: OrphanQualificationInput,
    businessStatus: string,
  ): Promise<void> {
    if (input.orphanReason === 'origin_business_archived') {
      if (businessStatus !== 'archived') {
        throw new AppError(
          'The origin business is not archived.',
          409,
          'ORPHAN_CONDITION_NOT_MET',
        );
      }
      return;
    }

    if (input.orphanReason === 'platform_unable_to_honor') {
      if (!input.actorUserId) {
        throw new AppError(
          'Platform determination requires an authenticated platform administrator.',
          403,
          'ORPHAN_PLATFORM_AUTHORITY_REQUIRED',
        );
      }
      const actor = await repos.users.findById(input.actorUserId);
      if (
        !actor ||
        actor.status !== 'active' ||
        actor.platformRole !== 'admin'
      ) {
        throw new AppError(
          'Only an active platform administrator may determine inability to honor.',
          403,
          'ORPHAN_PLATFORM_AUTHORITY_REQUIRED',
        );
      }
      return;
    }

    throw new AppError(
      'Unsupported orphaning condition.',
      422,
      'ORPHAN_REASON_INVALID',
    );
  }

  private assertClaimReplayMatches(
    claim: OrphanRewardClaim,
    expected: {
      customerId: string;
      originBusinessId: string;
      originLoyaltyAccountId: string;
      originLoyaltyTransactionId: string;
      originRewardId: string;
      orphanReason: OrphanReason;
      sourceRewardType: OrphanSourceRewardType;
    },
  ): void {
    if (
      claim.customerId !== expected.customerId ||
      claim.originBusinessId !== expected.originBusinessId ||
      claim.originLoyaltyAccountId !== expected.originLoyaltyAccountId ||
      claim.originLoyaltyTransactionId !== expected.originLoyaltyTransactionId ||
      claim.originRewardId !== expected.originRewardId ||
      claim.orphanReason !== expected.orphanReason ||
      claim.sourceRewardType !== expected.sourceRewardType
    ) {
      throw new AppError(
        'The source entitlement is already mapped to a materially different orphan claim.',
        409,
        'ORPHAN_CLAIM_CONFLICT',
      );
    }
  }
}
