import type {
  OrphanSettlementCompletionAuthorizationInput,
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

const COMPLETION_AUTH_TTL_SECONDS = 5 * 60;
const CLAIM_RESOURCE_TYPE = 'orphan_reward_claim';
const CLAIM_ACCESS_SCOPE = 'settlement_access:claim';
const SETTLEMENT_RESOURCE_TYPE = 'orphan_settlement';

export interface CustomerSettlementReview {
  settlement: OrphanSettlement;
  claim: OrphanRewardClaim;
}

export interface CustomerCompletionAuthorizationResult {
  settlement: OrphanSettlement;
  claim: OrphanRewardClaim;
  authorization: CustomerActionAuthorization;
  event: OrphanSettlementEvent;
  changed: boolean;
}

export class CustomerSettlementCompletionService {
  constructor(private readonly db: Database) {}

  async getReview(
    customerId: string,
    settlementId: string,
  ): Promise<CustomerSettlementReview> {
    const repos = createRepositories(this.db);
    const settlement = await repos.orphanSettlements.findById(settlementId);
    this.assertCustomerSettlement(settlement, customerId);

    if (
      settlement!.status !== 'reserved' &&
      settlement!.status !== 'completion_authorized'
    ) {
      throw new AppError(
        'This settlement is not awaiting customer completion authorization.',
        409,
        'ORPHAN_SETTLEMENT_NOT_AWAITING_COMPLETION',
      );
    }

    this.assertSettlementLive(settlement!);
    this.assertFulfillmentContractPresent(settlement!);

    const claim = await repos.orphanRewardClaims.findById(settlement!.claimId);
    this.assertReservedClaim(claim, settlement!);

    return { settlement: settlement!, claim: claim! };
  }

  async authorizeCompletion(
    customerId: string,
    settlementId: string,
    input: OrphanSettlementCompletionAuthorizationInput,
  ): Promise<CustomerCompletionAuthorizationResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const settlement = await repos.orphanSettlements.lockForUpdate(
        settlementId,
      );
      this.assertCustomerSettlement(settlement, customerId);

      if (
        settlement!.status !== 'reserved' &&
        settlement!.status !== 'completion_authorized'
      ) {
        throw new AppError(
          'This settlement is not eligible for customer completion authorization.',
          409,
          'ORPHAN_SETTLEMENT_NOT_AWAITING_COMPLETION',
        );
      }

      this.assertSettlementLive(settlement!);
      this.assertFulfillmentContractPresent(settlement!);
      this.assertAcknowledgedContract(settlement!, input);

      const claim = await repos.orphanRewardClaims.lockForUpdate(
        settlement!.claimId,
      );
      this.assertReservedClaim(claim, settlement!);

      const consent = await repos.consentGrants.findActiveForResource(
        customerId,
        settlement!.receivingBusinessId,
        'settlement_access',
        CLAIM_RESOURCE_TYPE,
        claim!.id,
      );

      if (
        !consent ||
        consent.scope !== CLAIM_ACCESS_SCOPE ||
        consent.customerId !== customerId ||
        consent.businessId !== settlement!.receivingBusinessId
      ) {
        throw new AppError(
          'Settlement access consent is no longer active for this receiving business and claim.',
          409,
          'ORPHAN_SETTLEMENT_CONSENT_INACTIVE',
        );
      }

      const priorAuthorization =
        settlement!.completionAuthorizationId === null
          ? undefined
          : await repos.customerActionAuthorizations.findById(
              settlement!.completionAuthorizationId,
            );

      if (
        settlement!.status === 'completion_authorized' &&
        priorAuthorization &&
        this.isUsable(priorAuthorization)
      ) {
        this.assertAuthorizationMatches(priorAuthorization, {
          customerId,
          businessId: settlement!.receivingBusinessId,
          settlementId: settlement!.id,
          claimId: claim!.id,
        });

        const expectedIdempotencyKey =
          `orphan-completion-auth:${input.idempotencyKey}`;
        if (
          priorAuthorization.idempotencyKey !== expectedIdempotencyKey ||
          priorAuthorization.correlationId !== input.correlationId
        ) {
          throw new AppError(
            'This settlement already has a live completion authorization.',
            409,
            'ORPHAN_COMPLETION_ALREADY_AUTHORIZED',
          );
        }

        const event = await repos.orphanSettlementEvents.findByIdempotencyKey(
          `completion-authorized:${priorAuthorization.id}`,
        );
        this.assertCompletionEvent(
          event,
          settlement!,
          claim!,
          priorAuthorization,
        );

        return {
          settlement: settlement!,
          claim: claim!,
          authorization: priorAuthorization,
          event: event!,
          changed: false,
        };
      }

      if (
        settlement!.status === 'completion_authorized' &&
        priorAuthorization &&
        priorAuthorization.status === 'active'
      ) {
        await repos.customerActionAuthorizations.revoke(
          priorAuthorization.id,
          customerId,
        );
      }

      const authorizationKey =
        `orphan-completion-auth:${input.idempotencyKey}`;
      const expiresAt = new Date(
        Math.min(
          Date.now() + COMPLETION_AUTH_TTL_SECONDS * 1000,
          settlement!.expiresAt.getTime(),
        ),
      );
      if (expiresAt <= new Date()) {
        throw new AppError(
          'The settlement reservation has expired.',
          409,
          'ORPHAN_SETTLEMENT_EXPIRED',
        );
      }

      const authorization =
        await repos.customerActionAuthorizations.create({
          customerId,
          businessId: settlement!.receivingBusinessId,
          actionType: 'complete_settlement',
          correlationId: input.correlationId,
          expiresAt,
          resourceType: SETTLEMENT_RESOURCE_TYPE,
          resourceId: settlement!.id,
          scope: this.completionScope(claim!.id),
          idempotencyKey: authorizationKey,
        });

      this.assertAuthorizationMatches(authorization, {
        customerId,
        businessId: settlement!.receivingBusinessId,
        settlementId: settlement!.id,
        claimId: claim!.id,
      });

      if (!this.isUsable(authorization)) {
        throw new AppError(
          'The completion authorization idempotency key resolves to an authorization that is no longer usable.',
          409,
          'ORPHAN_COMPLETION_IDEMPOTENCY_CONFLICT',
        );
      }

      if (
        authorization.correlationId !== input.correlationId ||
        authorization.idempotencyKey !== authorizationKey
      ) {
        throw new AppError(
          'The completion authorization idempotency key conflicts with another request.',
          409,
          'ORPHAN_COMPLETION_IDEMPOTENCY_CONFLICT',
        );
      }

      const completionAuthorizedAt = new Date();
      const updatedSettlement =
        await repos.orphanSettlements.authorizeCompletion(
          settlement!.id,
          {
            completionAuthorizationId: authorization.id,
            completionAuthorizedAt,
          },
        );

      if (!updatedSettlement) {
        throw new AppError(
          'The settlement could not transition to completion authorized.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const eventResult =
        await repos.orphanSettlementEvents.appendIdempotent({
          claimId: claim!.id,
          settlementId: updatedSettlement.id,
          customerId,
          eventType: 'completion_authorized',
          originBusinessId: claim!.originBusinessId,
          receivingBusinessId: updatedSettlement.receivingBusinessId,
          ...(updatedSettlement.receivingBranchId !== null
            ? { receivingBranchId: updatedSettlement.receivingBranchId }
            : {}),
          customerActionAuthorizationId: authorization.id,
          idempotencyKey: `completion-authorized:${authorization.id}`,
          metadata: {
            correlationId: input.correlationId,
            fulfillmentPolicyVersion:
              updatedSettlement.fulfillmentPolicyVersion,
            fulfillmentReference:
              updatedSettlement.fulfillmentReference,
            reauthorization:
              settlement!.status === 'completion_authorized',
          },
        });

      this.assertCompletionEvent(
        eventResult.event,
        updatedSettlement,
        claim!,
        authorization,
      );

      return {
        settlement: updatedSettlement,
        claim: claim!,
        authorization,
        event: eventResult.event,
        changed: true,
      };
    });
  }

  private assertCustomerSettlement(
    settlement: OrphanSettlement | undefined,
    customerId: string,
  ): void {
    if (!settlement || settlement.customerId !== customerId) {
      throw new AppError(
        'Orphan settlement not found.',
        404,
        'ORPHAN_SETTLEMENT_NOT_FOUND',
      );
    }
  }

  private assertSettlementLive(settlement: OrphanSettlement): void {
    if (settlement.expiresAt <= new Date()) {
      throw new AppError(
        'The settlement reservation has expired.',
        409,
        'ORPHAN_SETTLEMENT_EXPIRED',
      );
    }
  }

  private assertFulfillmentContractPresent(
    settlement: OrphanSettlement,
  ): void {
    if (
      !settlement.fulfillmentPolicyVersion ||
      !settlement.fulfillmentSnapshot
    ) {
      throw new AppError(
        'The receiving business has not supplied an authoritative fulfillment contract.',
        409,
        'ORPHAN_FULFILLMENT_CONTRACT_MISSING',
      );
    }
  }

  private assertAcknowledgedContract(
    settlement: OrphanSettlement,
    input: OrphanSettlementCompletionAuthorizationInput,
  ): void {
    if (
      settlement.fulfillmentPolicyVersion !==
        input.fulfillmentPolicyVersion ||
      settlement.fulfillmentReference !== input.fulfillmentReference
    ) {
      throw new AppError(
        'The fulfillment contract changed or does not match what the customer reviewed.',
        409,
        'ORPHAN_FULFILLMENT_ACKNOWLEDGEMENT_STALE',
      );
    }
  }

  private assertReservedClaim(
    claim: OrphanRewardClaim | undefined,
    settlement: OrphanSettlement,
  ): void {
    if (
      !claim ||
      claim.customerId !== settlement.customerId ||
      claim.id !== settlement.claimId ||
      claim.status !== 'reserved'
    ) {
      throw new AppError(
        'The orphan claim is no longer reserved for this settlement.',
        409,
        'ORPHAN_CLAIM_NOT_RESERVED',
      );
    }
  }

  private completionScope(claimId: string): string {
    return `settlement_completion:claim:${claimId}`;
  }

  private isUsable(
    authorization: CustomerActionAuthorization,
  ): boolean {
    return (
      authorization.status === 'active' &&
      authorization.expiresAt > new Date()
    );
  }

  private assertAuthorizationMatches(
    authorization: CustomerActionAuthorization,
    expected: {
      customerId: string;
      businessId: string;
      settlementId: string;
      claimId: string;
    },
  ): void {
    if (
      authorization.customerId !== expected.customerId ||
      authorization.businessId !== expected.businessId ||
      authorization.actionType !== 'complete_settlement' ||
      authorization.resourceType !== SETTLEMENT_RESOURCE_TYPE ||
      authorization.resourceId !== expected.settlementId ||
      authorization.scope !== this.completionScope(expected.claimId)
    ) {
      throw new AppError(
        'The completion authorization conflicts with another settlement scope.',
        409,
        'ORPHAN_COMPLETION_IDEMPOTENCY_CONFLICT',
      );
    }
  }

  private assertCompletionEvent(
    event: OrphanSettlementEvent | undefined,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    authorization: CustomerActionAuthorization,
  ): void {
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
        'Completion authorization history conflicts with the settlement state.',
        409,
        'ORPHAN_COMPLETION_EVENT_CONFLICT',
      );
    }
  }
}

export const ORPHAN_COMPLETION_AUTH_TTL_SECONDS =
  COMPLETION_AUTH_TTL_SECONDS;
