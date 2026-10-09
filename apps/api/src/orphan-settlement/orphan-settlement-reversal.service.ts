import type {
  OrphanSettlementReversalEvidence,
  OrphanSettlementReversalInput,
} from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import {
  createRepositories,
  type OrphanRewardClaim,
  type OrphanSettlement,
  type OrphanSettlementEvent,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface OrphanSettlementReversalAuditContext {
  actorUserId: string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface OrphanSettlementReversalResult {
  settlement: OrphanSettlement;
  claim: OrphanRewardClaim;
  reversalEvent: OrphanSettlementEvent;
  evidence: OrphanSettlementReversalEvidence;
  changed: boolean;
}

export class OrphanSettlementReversalService {
  constructor(private readonly db: Database) {}

  async reverse(
    settlementId: string,
    input: OrphanSettlementReversalInput,
    audit: OrphanSettlementReversalAuditContext,
  ): Promise<OrphanSettlementReversalResult> {
    const committed = await this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const settlement = await repos.orphanSettlements.lockForUpdate(
        settlementId,
      );

      if (!settlement) {
        throw new AppError(
          'Orphan settlement not found.',
          404,
          'ORPHAN_SETTLEMENT_NOT_FOUND',
        );
      }

      const claim = await repos.orphanRewardClaims.lockForUpdate(
        settlement.claimId,
      );
      if (!claim || claim.customerId !== settlement.customerId) {
        throw new AppError(
          'Settlement claim state is inconsistent.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      if (settlement.status === 'reversed') {
        if (claim.status !== 'reversed' || claim.reversedAt === null) {
          throw new AppError(
            'Reversed settlement projection is inconsistent with its claim.',
            409,
            'ORPHAN_SETTLEMENT_STATE_CONFLICT',
          );
        }

        const event =
          await repos.orphanSettlementEvents.findByIdempotencyKey(
            `settlement-reversed:${input.idempotencyKey}`,
          );
        this.assertReversalEvent(event, settlement, claim, input, audit);

        return {
          settlement,
          claim,
          reversalEvent: event!,
          changed: false,
        };
      }

      if (
        settlement.status !== 'fulfilled' ||
        settlement.fulfilledAt === null ||
        claim.status !== 'settled' ||
        claim.settledAt === null
      ) {
        throw new AppError(
          'Only a fulfilled settlement with a settled claim may be reversed.',
          409,
          'ORPHAN_SETTLEMENT_REVERSAL_NOT_ALLOWED',
        );
      }

      const fulfilledEvent =
        await repos.orphanSettlementEvents.findByIdempotencyKey(
          `settlement-fulfilled:${settlement.id}`,
        );
      this.assertFulfilledHistory(fulfilledEvent, settlement, claim);

      const reversedAt = new Date();
      const reversedSettlement =
        await repos.orphanSettlements.reverseFulfilled(settlement.id);
      if (!reversedSettlement) {
        throw new AppError(
          'The settlement could not transition to reversed.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const reversedClaim = await repos.orphanRewardClaims.reverseSettled(
        claim.id,
        reversedAt,
      );
      if (!reversedClaim) {
        throw new AppError(
          'The orphan claim could not transition to reversed.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      const eventResult =
        await repos.orphanSettlementEvents.appendIdempotent({
          claimId: reversedClaim.id,
          settlementId: reversedSettlement.id,
          customerId: reversedSettlement.customerId,
          eventType: 'settlement_reversed',
          originBusinessId: reversedClaim.originBusinessId,
          receivingBusinessId: reversedSettlement.receivingBusinessId,
          ...(reversedSettlement.receivingBranchId !== null
            ? { receivingBranchId: reversedSettlement.receivingBranchId }
            : {}),
          actorUserId: audit.actorUserId,
          customerActionAuthorizationId:
            reversedSettlement.completionAuthorizationId,
          idempotencyKey: `settlement-reversed:${input.idempotencyKey}`,
          metadata: {
            reasonCode: input.reasonCode,
            evidenceReference: input.evidenceReference,
            note: input.note ?? null,
            originalFulfilledAt:
              reversedSettlement.fulfilledAt?.toISOString() ?? null,
          },
        });

      this.assertReversalEvent(
        eventResult.event,
        reversedSettlement,
        reversedClaim,
        input,
        audit,
      );

      await repos.auditLog.record({
        businessId: reversedSettlement.receivingBusinessId,
        actorUserId: audit.actorUserId,
        action: 'orphan_settlement.reversed',
        entityType: 'orphan_settlement',
        entityId: reversedSettlement.id,
        metadata: {
          claimId: reversedClaim.id,
          originBusinessId: reversedClaim.originBusinessId,
          receivingBusinessId: reversedSettlement.receivingBusinessId,
          receivingBranchId: reversedSettlement.receivingBranchId,
          reasonCode: input.reasonCode,
          evidenceReference: input.evidenceReference,
          reversalEventId: eventResult.event.id,
        },
        ipAddress: audit.ipAddress ?? null,
        userAgent: audit.userAgent ?? null,
      });

      return {
        settlement: reversedSettlement,
        claim: reversedClaim,
        reversalEvent: eventResult.event,
        changed: true,
      };
    });

    return {
      ...committed,
      evidence: this.buildEvidence(
        committed.settlement,
        committed.claim,
        committed.reversalEvent,
      ),
    };
  }

  async getReversalEvidence(
    settlementRef: string,
  ): Promise<OrphanSettlementReversalEvidence> {
    const repos = createRepositories(this.db);
    const settlement = await repos.orphanSettlements.findById(settlementRef);
    if (
      !settlement ||
      settlement.status !== 'reversed' ||
      settlement.fulfilledAt === null
    ) {
      throw new AppError(
        'Orphan settlement reversal evidence not found.',
        404,
        'ORPHAN_SETTLEMENT_REVERSAL_EVIDENCE_NOT_FOUND',
      );
    }

    const claim = await repos.orphanRewardClaims.findById(settlement.claimId);
    if (
      !claim ||
      claim.status !== 'reversed' ||
      claim.reversedAt === null ||
      claim.customerId !== settlement.customerId
    ) {
      throw new AppError(
        'Reversed orphan settlement state is inconsistent.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }

    const events = await repos.orphanSettlementEvents.listForSettlement(
      settlement.id,
    );
    const reversalEvents = events.filter(
      (event) => event.eventType === 'settlement_reversed',
    );
    if (reversalEvents.length !== 1) {
      throw new AppError(
        'Reversed settlement does not have exactly one authoritative reversal event.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }

    return this.buildEvidence(settlement, claim, reversalEvents[0]!);
  }

  private assertFulfilledHistory(
    event: OrphanSettlementEvent | undefined,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
  ): void {
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
        'Fulfilled settlement is missing authoritative fulfillment history.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }
  }

  private assertReversalEvent(
    event: OrphanSettlementEvent | undefined,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    input: OrphanSettlementReversalInput,
    audit: OrphanSettlementReversalAuditContext,
  ): void {
    if (
      !event ||
      event.eventType !== 'settlement_reversed' ||
      event.settlementId !== settlement.id ||
      event.claimId !== claim.id ||
      event.customerId !== settlement.customerId ||
      event.originBusinessId !== claim.originBusinessId ||
      event.receivingBusinessId !== settlement.receivingBusinessId ||
      event.receivingBranchId !== settlement.receivingBranchId ||
      event.actorUserId !== audit.actorUserId ||
      event.metadata.reasonCode !== input.reasonCode ||
      event.metadata.evidenceReference !== input.evidenceReference
    ) {
      throw new AppError(
        'Settlement reversal idempotency conflicts with another reversal.',
        409,
        'ORPHAN_SETTLEMENT_REVERSAL_CONFLICT',
      );
    }
  }

  private buildEvidence(
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    event: OrphanSettlementEvent,
  ): OrphanSettlementReversalEvidence {
    if (
      settlement.status !== 'reversed' ||
      settlement.fulfilledAt === null ||
      claim.status !== 'reversed' ||
      claim.reversedAt === null ||
      event.eventType !== 'settlement_reversed'
    ) {
      throw new AppError(
        'Settlement is not eligible to emit reversal evidence.',
        409,
        'ORPHAN_SETTLEMENT_STATE_CONFLICT',
      );
    }

    const reasonCode = event.metadata.reasonCode;
    const evidenceReference = event.metadata.evidenceReference;
    if (
      typeof reasonCode !== 'string' ||
      typeof evidenceReference !== 'string'
    ) {
      throw new AppError(
        'Settlement reversal evidence metadata is invalid.',
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
      originalFulfilledAt: settlement.fulfilledAt.toISOString(),
      reversedAt: claim.reversedAt.toISOString(),
      reversalRef: event.id,
      reasonCode,
      evidenceReference,
    };
  }
}
