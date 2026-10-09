import type {
  OrphanSettlementCompletionEvidence,
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

const SETTLEMENT_RESOURCE_TYPE = 'orphan_settlement';

export interface OrphanSettlementFulfillmentResult {
  claim: OrphanRewardClaim;
  settlement: OrphanSettlement;
  settlementFulfilledEvent: OrphanSettlementEvent;
  evidence: OrphanSettlementCompletionEvidence;
  changed: boolean;
}

export class OrphanSettlementFulfillmentService {
  constructor(private readonly db: Database) {}

  async fulfill(input: {
    businessId: string;
    branchId?: string | undefined;
    actorUserId: string;
    settlementId: string;
  }): Promise<OrphanSettlementFulfillmentResult> {
    const committed = await this.db.transaction(async (tx) => {
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

      this.assertExactBranchContext(settlement, input.branchId);

      if (settlement.status === 'fulfilled') {
        const claim = await repos.orphanRewardClaims.lockForUpdate(
          settlement.claimId,
        );
        if (
          !claim ||
          claim.customerId !== settlement.customerId ||
          claim.status !== 'settled' ||
          claim.settledAt === null
        ) {
          throw new AppError(
            'Fulfilled settlement projection is inconsistent with its claim.',
            409,
            'ORPHAN_SETTLEMENT_STATE_CONFLICT',
          );
        }

        const authorization = await this.resolveCompletionAuthorization(
          repos,
          settlement,
          claim,
          false,
        );
        const event = await this.resolveCompletionAuthorizedEvent(
          repos,
          settlement,
          claim,
          authorization,
        );
        void event;

        const fulfilledEvent =
          await repos.orphanSettlementEvents.findByIdempotencyKey(
            `settlement-fulfilled:${settlement.id}`,
          );
        this.assertFulfilledEvent(
          fulfilledEvent,
          settlement,
          claim,
          authorization,
        );

        return {
          claim,
          settlement,
          settlementFulfilledEvent: fulfilledEvent!,
          changed: false,
        };
      }

      if (settlement.status !== 'completion_authorized') {
        throw new AppError(
          'Settlement is not authorized for fulfillment.',
          409,
          'ORPHAN_SETTLEMENT_NOT_COMPLETION_AUTHORIZED',
        );
      }

      if (settlement.expiresAt <= new Date()) {
        throw new AppError(
          'The settlement reservation has expired.',
          409,
          'ORPHAN_SETTLEMENT_EXPIRED',
        );
      }

      if (
        !settlement.fulfillmentPolicyVersion ||
        !settlement.fulfillmentSnapshot ||
        settlement.completionAuthorizationId === null ||
        settlement.completionAuthorizedAt === null
      ) {
        throw new AppError(
          'Settlement completion state is incomplete.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const claim = await repos.orphanRewardClaims.lockForUpdate(
        settlement.claimId,
      );
      if (
        !claim ||
        claim.customerId !== settlement.customerId ||
        claim.status !== 'reserved'
      ) {
        throw new AppError(
          'The orphan claim is no longer reserved for this settlement.',
          409,
          'ORPHAN_CLAIM_NOT_RESERVED',
        );
      }

      const authorization = await this.resolveCompletionAuthorization(
        repos,
        settlement,
        claim,
        true,
      );

      await this.resolveCompletionAuthorizedEvent(
        repos,
        settlement,
        claim,
        authorization,
      );

      const consumed = await repos.customerActionAuthorizations.consume(
        authorization.id,
        settlement.customerId,
      );
      if (!consumed) {
        throw new AppError(
          'The completion authorization is invalid, expired, revoked, consumed, or out of scope.',
          409,
          'ORPHAN_COMPLETION_AUTHORIZATION_INVALID',
        );
      }

      const fulfilledAt = new Date();

      const fulfilledSettlement =
        await repos.orphanSettlements.fulfillCompletionAuthorized(
          settlement.id,
          {
            fulfilledByUserId: input.actorUserId,
            fulfilledAt,
          },
        );
      if (!fulfilledSettlement) {
        throw new AppError(
          'The settlement could not transition to fulfilled.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const settledClaim = await repos.orphanRewardClaims.settleReserved(
        claim.id,
        fulfilledAt,
      );
      if (!settledClaim) {
        throw new AppError(
          'The orphan claim could not transition to settled.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const eventResult =
        await repos.orphanSettlementEvents.appendIdempotent({
          claimId: settledClaim.id,
          settlementId: fulfilledSettlement.id,
          customerId: fulfilledSettlement.customerId,
          eventType: 'settlement_fulfilled',
          originBusinessId: settledClaim.originBusinessId,
          receivingBusinessId: fulfilledSettlement.receivingBusinessId,
          ...(fulfilledSettlement.receivingBranchId !== null
            ? { receivingBranchId: fulfilledSettlement.receivingBranchId }
            : {}),
          actorUserId: input.actorUserId,
          customerActionAuthorizationId: consumed.id,
          idempotencyKey: `settlement-fulfilled:${fulfilledSettlement.id}`,
          metadata: {
            fulfillmentPolicyVersion:
              fulfilledSettlement.fulfillmentPolicyVersion,
            fulfillmentReference:
              fulfilledSettlement.fulfillmentReference,
          },
        });

      this.assertFulfilledEvent(
        eventResult.event,
        fulfilledSettlement,
        settledClaim,
        consumed,
      );

      return {
        claim: settledClaim,
        settlement: fulfilledSettlement,
        settlementFulfilledEvent: eventResult.event,
        changed: true,
      };
    });

    // Evidence is constructed only after the transaction callback resolves,
    // so no downstream consumer can observe terminal evidence for rolled-back
    // fulfillment.
    return {
      ...committed,
      evidence: this.buildEvidence(
        committed.settlement,
        committed.claim,
      ),
    };
  }

  async getCompletionEvidence(
    settlementRef: string,
  ): Promise<OrphanSettlementCompletionEvidence> {
    const repos = createRepositories(this.db);
    const settlement = await repos.orphanSettlements.findById(settlementRef);
    if (settlement?.status === 'reversed') {
      throw new AppError(
        'Orphan settlement completion evidence has been invalidated by reversal.',
        409,
        'ORPHAN_SETTLEMENT_COMPLETION_EVIDENCE_INVALIDATED',
      );
    }
    if (
      !settlement ||
      settlement.status !== 'fulfilled' ||
      settlement.fulfilledAt === null ||
      !settlement.fulfillmentPolicyVersion
    ) {
      throw new AppError(
        'Completed orphan settlement evidence not found.',
        404,
        'ORPHAN_SETTLEMENT_COMPLETION_EVIDENCE_NOT_FOUND',
      );
    }

    const claim = await repos.orphanRewardClaims.findById(settlement.claimId);
    if (
      !claim ||
      claim.customerId !== settlement.customerId ||
      claim.status !== 'settled' ||
      claim.settledAt === null
    ) {
      throw new AppError(
        'Completed orphan settlement evidence is inconsistent.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }

    const event = await repos.orphanSettlementEvents.findByIdempotencyKey(
      `settlement-fulfilled:${settlement.id}`,
    );
    if (
      !event ||
      event.eventType !== 'settlement_fulfilled' ||
      event.settlementId !== settlement.id ||
      event.claimId !== claim.id ||
      event.customerId !== settlement.customerId ||
      event.originBusinessId !== claim.originBusinessId ||
      event.receivingBusinessId !== settlement.receivingBusinessId ||
      event.receivingBranchId !== settlement.receivingBranchId
    ) {
      throw new AppError(
        'Completed orphan settlement evidence is missing authoritative history.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }

    return this.buildEvidence(settlement, claim);
  }

  private async resolveCompletionAuthorization(
    repos: ReturnType<typeof createRepositories>,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    requireActive: boolean,
  ): Promise<CustomerActionAuthorization> {
    if (settlement.completionAuthorizationId === null) {
      throw new AppError(
        'Settlement has no completion authorization.',
        409,
        'ORPHAN_COMPLETION_AUTHORIZATION_INVALID',
      );
    }

    const authorization =
      await repos.customerActionAuthorizations.findById(
        settlement.completionAuthorizationId,
      );

    const statusValid = requireActive
      ? authorization?.status === 'active' &&
        authorization.expiresAt > new Date()
      : authorization?.status === 'consumed';

    if (
      !authorization ||
      !statusValid ||
      authorization.customerId !== settlement.customerId ||
      authorization.businessId !== settlement.receivingBusinessId ||
      authorization.actionType !== 'complete_settlement' ||
      authorization.resourceType !== SETTLEMENT_RESOURCE_TYPE ||
      authorization.resourceId !== settlement.id ||
      authorization.scope !==
        `settlement_completion:claim:${claim.id}`
    ) {
      throw new AppError(
        'The completion authorization is invalid, expired, revoked, consumed, or out of scope.',
        409,
        'ORPHAN_COMPLETION_AUTHORIZATION_INVALID',
      );
    }

    return authorization;
  }

  private async resolveCompletionAuthorizedEvent(
    repos: ReturnType<typeof createRepositories>,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    authorization: CustomerActionAuthorization,
  ): Promise<OrphanSettlementEvent> {
    const event = await repos.orphanSettlementEvents.findByIdempotencyKey(
      `completion-authorized:${authorization.id}`,
    );

    if (
      !event ||
      event.eventType !== 'completion_authorized' ||
      event.settlementId !== settlement.id ||
      event.claimId !== claim.id ||
      event.customerId !== settlement.customerId ||
      event.originBusinessId !== claim.originBusinessId ||
      event.receivingBusinessId !== settlement.receivingBusinessId ||
      event.receivingBranchId !== settlement.receivingBranchId ||
      event.customerActionAuthorizationId !== authorization.id
    ) {
      throw new AppError(
        'Settlement completion authorization is missing authoritative history.',
        409,
        'ORPHAN_COMPLETION_EVENT_CONFLICT',
      );
    }

    return event;
  }

  private assertFulfilledEvent(
    event: OrphanSettlementEvent | undefined,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    authorization: CustomerActionAuthorization,
  ): void {
    if (
      !event ||
      event.eventType !== 'settlement_fulfilled' ||
      event.settlementId !== settlement.id ||
      event.claimId !== claim.id ||
      event.customerId !== settlement.customerId ||
      event.originBusinessId !== claim.originBusinessId ||
      event.receivingBusinessId !== settlement.receivingBusinessId ||
      event.receivingBranchId !== settlement.receivingBranchId ||
      event.customerActionAuthorizationId !== authorization.id
    ) {
      throw new AppError(
        'Settlement fulfillment history conflicts with terminal state.',
        409,
        'ORPHAN_SETTLEMENT_EVENT_CONFLICT',
      );
    }
  }

  private assertExactBranchContext(
    settlement: OrphanSettlement,
    branchId: string | undefined,
  ): void {
    if (settlement.receivingBranchId !== (branchId ?? null)) {
      throw new AppError(
        'This settlement is bound to a different receiving branch context.',
        403,
        'ORPHAN_SETTLEMENT_BRANCH_MISMATCH',
      );
    }
  }

  private buildEvidence(
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
  ): OrphanSettlementCompletionEvidence {
    if (
      settlement.status !== 'fulfilled' ||
      settlement.fulfilledAt === null ||
      !settlement.fulfillmentPolicyVersion ||
      claim.status !== 'settled'
    ) {
      throw new AppError(
        'Settlement is not eligible to emit terminal completion evidence.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }

    return {
      evidenceVersion: 'v1',
      settlementRef: settlement.id,
      claimId: claim.id,
      customerId: settlement.customerId,
      originBusinessId: claim.originBusinessId,
      receivingBusinessId: settlement.receivingBusinessId,
      receivingBranchId: settlement.receivingBranchId,
      fulfilledAt: settlement.fulfilledAt.toISOString(),
      fulfillmentPolicyVersion: settlement.fulfillmentPolicyVersion,
      fulfillmentReference: settlement.fulfillmentReference,
    };
  }
}
