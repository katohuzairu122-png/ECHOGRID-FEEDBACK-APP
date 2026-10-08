import type {
  OrphanSettlementAcceptInput,
  OrphanSettlementBusinessAccessInput,
  OrphanSettlementFulfillmentContractInput,
} from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import {
  createRepositories,
  type CustomerActionAuthorization,
  type OrphanRewardClaim,
  type OrphanSettlement,
  type OrphanSettlementEvent,
} from '../repositories';
import { AppError } from '../lib/errors';

const ACCESS_SCOPE = 'settlement_access:claim';
const CLAIM_RESOURCE_TYPE = 'orphan_reward_claim';
const FULFILLMENT_POLICY_VERSION = 'split06-structured-benefit-v1';

export interface ReceivingBusinessClaimView {
  settlementId: string;
  claimId: string;
  receivingBusinessId: string;
  receivingBranchId: string | null;
  settlementStatus: 'proposed' | 'accepted' | 'reserved' | 'completion_authorized' | 'fulfilled' | 'cancelled' | 'expired' | 'reversed';
  authorizationExpiresAt: Date;
  claim: {
    orphanReason: 'origin_business_archived' | 'platform_unable_to_honor';
    sourceRewardType: 'discount' | 'free_item' | 'voucher';
    reward: {
      name: string | null;
      description: string | null;
      value: string | null;
      expiryDate: string | null;
    };
  };
}

export interface ReceivingBusinessAcceptanceResult {
  claim: OrphanRewardClaim;
  settlement: OrphanSettlement;
  partnerAcceptedEvent: OrphanSettlementEvent;
  settlementReservedEvent: OrphanSettlementEvent;
  changed: boolean;
}

export class ReceivingBusinessSettlementService {
  constructor(private readonly db: Database) {}

  async inspectAuthorizedClaim(input: {
    businessId: string;
    branchId?: string | undefined;
    access: OrphanSettlementBusinessAccessInput;
  }): Promise<ReceivingBusinessClaimView> {
    const repos = createRepositories(this.db);
    const settlement = await repos.orphanSettlements.findById(
      input.access.settlementId,
    );

    if (!settlement || settlement.receivingBusinessId !== input.businessId) {
      throw new AppError(
        'Settlement not found.',
        404,
        'ORPHAN_SETTLEMENT_NOT_FOUND',
      );
    }

    if (settlement.status !== 'proposed') {
      throw new AppError(
        'Settlement is no longer awaiting receiving-business acceptance.',
        409,
        'ORPHAN_SETTLEMENT_NOT_PROPOSED',
      );
    }

    if (settlement.expiresAt <= new Date()) {
      throw new AppError(
        'The settlement access window has expired.',
        409,
        'ORPHAN_SETTLEMENT_ACCESS_EXPIRED',
      );
    }

    this.assertBranchContext(settlement, input.branchId);

    const authorization = await repos.customerActionAuthorizations.findById(
      input.access.authorizationId,
    );
    this.assertActiveAccessAuthorization(authorization, settlement);

    const claim = await repos.orphanRewardClaims.findById(settlement.claimId);
    if (
      !claim ||
      claim.customerId !== settlement.customerId ||
      claim.status !== 'available'
    ) {
      throw new AppError(
        'The orphan claim is no longer available for settlement.',
        409,
        'ORPHAN_CLAIM_NOT_AVAILABLE',
      );
    }

    return this.serializeAuthorizedView(settlement, claim, authorization!);
  }

  async acceptAndReserve(input: {
    businessId: string;
    branchId?: string | undefined;
    actorUserId: string;
    settlementId: string;
    acceptance: OrphanSettlementAcceptInput;
  }): Promise<ReceivingBusinessAcceptanceResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const settlement = await repos.orphanSettlements.lockForUpdate(
        input.settlementId,
      );

      if (!settlement || settlement.receivingBusinessId !== input.businessId) {
        throw new AppError(
          'Settlement not found.',
          404,
          'ORPHAN_SETTLEMENT_NOT_FOUND',
        );
      }

      this.assertBranchContext(settlement, input.branchId);

      const authorization = await repos.customerActionAuthorizations.findById(
        input.acceptance.authorizationId,
      );

      if (settlement.status === 'reserved') {
        this.assertReplayAuthorization(authorization, settlement);
        this.assertReservedReplayMatches(
          settlement,
          input.branchId,
          input.acceptance.fulfillment,
        );

        const claim = await repos.orphanRewardClaims.lockForUpdate(
          settlement.claimId,
        );
        if (!claim || claim.status !== 'reserved') {
          throw new AppError(
            'Reserved settlement projection is inconsistent with its claim.',
            409,
            'ORPHAN_SETTLEMENT_STATE_CONFLICT',
          );
        }

        const events = await this.resolveReservationEvents(
          repos,
          claim,
          settlement,
          input.actorUserId,
          false,
        );

        return {
          claim,
          settlement,
          ...events,
          changed: false,
        };
      }

      if (settlement.status !== 'proposed') {
        throw new AppError(
          'Settlement is no longer awaiting receiving-business acceptance.',
          409,
          'ORPHAN_SETTLEMENT_NOT_PROPOSED',
        );
      }

      if (settlement.expiresAt <= new Date()) {
        throw new AppError(
          'The settlement access window has expired.',
          409,
          'ORPHAN_SETTLEMENT_ACCESS_EXPIRED',
        );
      }

      this.assertActiveAccessAuthorization(authorization, settlement);

      const claim = await repos.orphanRewardClaims.lockForUpdate(
        settlement.claimId,
      );
      if (
        !claim ||
        claim.customerId !== settlement.customerId ||
        claim.status !== 'available'
      ) {
        throw new AppError(
          'The orphan claim is no longer available for settlement.',
          409,
          'ORPHAN_CLAIM_NOT_AVAILABLE',
        );
      }

      const consumed = await repos.customerActionAuthorizations.consume(
        authorization!.id,
        settlement.customerId,
      );
      if (!consumed) {
        throw new AppError(
          'The settlement access authorization is invalid, expired, revoked, or already used.',
          409,
          'ORPHAN_SETTLEMENT_ACCESS_INVALID',
        );
      }

      const acceptedAt = new Date();
      const snapshot = this.buildFulfillmentSnapshot(
        input.acceptance.fulfillment,
      );

      const reservedClaim = await repos.orphanRewardClaims.reserveAvailable(
        claim.id,
      );
      if (!reservedClaim) {
        throw new AppError(
          'The orphan claim could not be reserved.',
          409,
          'ORPHAN_CLAIM_NOT_AVAILABLE',
        );
      }

      const reservedSettlement = await repos.orphanSettlements.reserveProposed(
        settlement.id,
        {
          ...(input.branchId !== undefined
            ? { receivingBranchId: input.branchId }
            : {}),
          acceptedByUserId: input.actorUserId,
          acceptedAt,
          fulfillmentPolicyVersion: FULFILLMENT_POLICY_VERSION,
          fulfillmentSnapshot: snapshot,
          ...(input.acceptance.fulfillment.reference !== undefined
            ? {
                fulfillmentReference:
                  input.acceptance.fulfillment.reference,
              }
            : {}),
        },
      );

      if (!reservedSettlement) {
        throw new AppError(
          'The settlement could not be reserved.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const events = await this.resolveReservationEvents(
        repos,
        reservedClaim,
        reservedSettlement,
        input.actorUserId,
        true,
      );

      return {
        claim: reservedClaim,
        settlement: reservedSettlement,
        ...events,
        changed: true,
      };
    });
  }

  private assertActiveAccessAuthorization(
    authorization: CustomerActionAuthorization | undefined,
    settlement: OrphanSettlement,
  ): void {
    if (
      !authorization ||
      authorization.id !== settlement.accessAuthorizationId ||
      authorization.status !== 'active' ||
      authorization.expiresAt <= new Date() ||
      authorization.customerId !== settlement.customerId ||
      authorization.businessId !== settlement.receivingBusinessId ||
      authorization.actionType !== 'access_orphan_settlement' ||
      authorization.resourceType !== CLAIM_RESOURCE_TYPE ||
      authorization.resourceId !== settlement.claimId ||
      authorization.scope !== ACCESS_SCOPE
    ) {
      throw new AppError(
        'The settlement access authorization is invalid, expired, revoked, consumed, or out of scope.',
        409,
        'ORPHAN_SETTLEMENT_ACCESS_INVALID',
      );
    }
  }

  private assertReplayAuthorization(
    authorization: CustomerActionAuthorization | undefined,
    settlement: OrphanSettlement,
  ): void {
    if (
      !authorization ||
      authorization.id !== settlement.accessAuthorizationId ||
      authorization.customerId !== settlement.customerId ||
      authorization.businessId !== settlement.receivingBusinessId ||
      authorization.actionType !== 'access_orphan_settlement' ||
      authorization.resourceType !== CLAIM_RESOURCE_TYPE ||
      authorization.resourceId !== settlement.claimId ||
      authorization.scope !== ACCESS_SCOPE ||
      !['active', 'consumed'].includes(authorization.status)
    ) {
      throw new AppError(
        'The settlement access authorization does not match this reservation.',
        409,
        'ORPHAN_SETTLEMENT_ACCESS_INVALID',
      );
    }
  }

  private assertBranchContext(
    settlement: OrphanSettlement,
    branchId: string | undefined,
  ): void {
    if (
      settlement.receivingBranchId !== null &&
      settlement.receivingBranchId !== branchId
    ) {
      throw new AppError(
        'This settlement is reserved to a different receiving branch.',
        403,
        'ORPHAN_SETTLEMENT_BRANCH_MISMATCH',
      );
    }
  }

  private assertReservedReplayMatches(
    settlement: OrphanSettlement,
    branchId: string | undefined,
    fulfillment: OrphanSettlementFulfillmentContractInput,
  ): void {
    const expected = this.buildFulfillmentSnapshot(fulfillment);
    if (
      settlement.receivingBranchId !== (branchId ?? null) ||
      settlement.fulfillmentPolicyVersion !== FULFILLMENT_POLICY_VERSION ||
      JSON.stringify(settlement.fulfillmentSnapshot) !==
        JSON.stringify(expected) ||
      settlement.fulfillmentReference !== (fulfillment.reference ?? null)
    ) {
      throw new AppError(
        'The settlement is already reserved with a different fulfillment contract or branch.',
        409,
        'ORPHAN_SETTLEMENT_ACCEPTANCE_CONFLICT',
      );
    }
  }

  private buildFulfillmentSnapshot(
    fulfillment: OrphanSettlementFulfillmentContractInput,
  ): Record<string, unknown> {
    return {
      benefitType: fulfillment.benefitType,
      title: fulfillment.title,
      description: fulfillment.description,
      terms: fulfillment.terms ?? null,
    };
  }

  private serializeAuthorizedView(
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    authorization: CustomerActionAuthorization,
  ): ReceivingBusinessClaimView {
    const snapshot = claim.sourceRewardSnapshot;
    return {
      settlementId: settlement.id,
      claimId: claim.id,
      receivingBusinessId: settlement.receivingBusinessId,
      receivingBranchId: settlement.receivingBranchId,
      settlementStatus: settlement.status,
      authorizationExpiresAt: authorization.expiresAt,
      claim: {
        orphanReason: claim.orphanReason,
        sourceRewardType: claim.sourceRewardType,
        reward: {
          name:
            typeof snapshot.rewardName === 'string'
              ? snapshot.rewardName
              : null,
          description:
            typeof snapshot.description === 'string'
              ? snapshot.description
              : null,
          value:
            typeof snapshot.rewardValue === 'string'
              ? snapshot.rewardValue
              : null,
          expiryDate:
            typeof snapshot.expiryDate === 'string'
              ? snapshot.expiryDate
              : null,
        },
      },
    };
  }

  private async resolveReservationEvents(
    repos: ReturnType<typeof createRepositories>,
    claim: OrphanRewardClaim,
    settlement: OrphanSettlement,
    actorUserId: string,
    insertIfMissing: boolean,
  ): Promise<{
    partnerAcceptedEvent: OrphanSettlementEvent;
    settlementReservedEvent: OrphanSettlementEvent;
  }> {
    const acceptedInput = {
      claimId: claim.id,
      settlementId: settlement.id,
      customerId: claim.customerId,
      eventType: 'partner_accepted' as const,
      originBusinessId: claim.originBusinessId,
      receivingBusinessId: settlement.receivingBusinessId,
      ...(settlement.receivingBranchId !== null
        ? { receivingBranchId: settlement.receivingBranchId }
        : {}),
      actorUserId,
      customerActionAuthorizationId: settlement.accessAuthorizationId,
      idempotencyKey: `partner-accepted:${settlement.id}`,
      metadata: {
        fulfillmentPolicyVersion: settlement.fulfillmentPolicyVersion,
      },
    };

    const reservedInput = {
      claimId: claim.id,
      settlementId: settlement.id,
      customerId: claim.customerId,
      eventType: 'settlement_reserved' as const,
      originBusinessId: claim.originBusinessId,
      receivingBusinessId: settlement.receivingBusinessId,
      ...(settlement.receivingBranchId !== null
        ? { receivingBranchId: settlement.receivingBranchId }
        : {}),
      actorUserId,
      customerActionAuthorizationId: settlement.accessAuthorizationId,
      idempotencyKey: `settlement-reserved:${settlement.id}`,
      metadata: {
        fulfillmentPolicyVersion: settlement.fulfillmentPolicyVersion,
      },
    };

    if (!insertIfMissing) {
      const [accepted, reserved] = await Promise.all([
        repos.orphanSettlementEvents.findByIdempotencyKey(
          acceptedInput.idempotencyKey,
        ),
        repos.orphanSettlementEvents.findByIdempotencyKey(
          reservedInput.idempotencyKey,
        ),
      ]);
      if (!accepted || !reserved) {
        throw new AppError(
          'Reserved settlement is missing its authoritative history.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }
      this.assertEventMatches(accepted, acceptedInput);
      this.assertEventMatches(reserved, reservedInput);
      return {
        partnerAcceptedEvent: accepted,
        settlementReservedEvent: reserved,
      };
    }

    const acceptedResult =
      await repos.orphanSettlementEvents.appendIdempotent(acceptedInput);
    const reservedResult =
      await repos.orphanSettlementEvents.appendIdempotent(reservedInput);

    this.assertEventMatches(acceptedResult.event, acceptedInput);
    this.assertEventMatches(reservedResult.event, reservedInput);

    return {
      partnerAcceptedEvent: acceptedResult.event,
      settlementReservedEvent: reservedResult.event,
    };
  }

  private assertEventMatches(
    event: OrphanSettlementEvent,
    expected: {
      claimId: string;
      settlementId: string;
      customerId: string;
      eventType: 'partner_accepted' | 'settlement_reserved';
      originBusinessId: string;
      receivingBusinessId: string;
      receivingBranchId?: string | undefined;
      customerActionAuthorizationId: string;
    },
  ): void {
    if (
      event.claimId !== expected.claimId ||
      event.settlementId !== expected.settlementId ||
      event.customerId !== expected.customerId ||
      event.eventType !== expected.eventType ||
      event.originBusinessId !== expected.originBusinessId ||
      event.receivingBusinessId !== expected.receivingBusinessId ||
      event.receivingBranchId !== (expected.receivingBranchId ?? null) ||
      event.customerActionAuthorizationId !==
        expected.customerActionAuthorizationId
    ) {
      throw new AppError(
        'Settlement event idempotency conflicts with another reservation.',
        409,
        'ORPHAN_SETTLEMENT_EVENT_CONFLICT',
      );
    }
  }
}

export const ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION =
  FULFILLMENT_POLICY_VERSION;
