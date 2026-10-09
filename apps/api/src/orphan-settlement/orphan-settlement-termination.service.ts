import type { Database } from '../db/client';
import {
  createRepositories,
  type OrphanRewardClaim,
  type OrphanSettlement,
  type OrphanSettlementEvent,
} from '../repositories';
import { AppError } from '../lib/errors';

type TerminationKind = 'cancelled' | 'expired';

export interface OrphanSettlementTerminationResult {
  claim: OrphanRewardClaim;
  settlement: OrphanSettlement;
  event: OrphanSettlementEvent;
  changed: boolean;
  claimReleased: boolean;
}

export class OrphanSettlementTerminationService {
  constructor(private readonly db: Database) {}

  async cancelForCustomer(
    customerId: string,
    settlementId: string,
  ): Promise<OrphanSettlementTerminationResult> {
    return this.terminate({
      kind: 'cancelled',
      settlementId,
      customerId,
      now: new Date(),
    });
  }

  async expireSettlement(
    settlementId: string,
    now = new Date(),
  ): Promise<OrphanSettlementTerminationResult> {
    return this.terminate({
      kind: 'expired',
      settlementId,
      now,
    });
  }

  async expireDue(now = new Date(), limit = 100): Promise<number> {
    const repos = createRepositories(this.db);
    const due = await repos.orphanSettlements.listExpiredActive(now, limit);
    let changed = 0;

    for (const settlement of due) {
      try {
        const result = await this.expireSettlement(settlement.id, now);
        if (result.changed) changed += 1;
      } catch (error) {
        // Fail closed per the frozen claim-expiry boundary. A due reservation
        // whose underlying claim is no longer releasable is left untouched
        // for explicit policy/admin handling rather than silently expiring
        // claim value under an invented policy.
        if (
          error instanceof AppError &&
          error.code === 'ORPHAN_CLAIM_NOT_RELEASABLE'
        ) {
          continue;
        }
        throw error;
      }
    }

    return changed;
  }

  private async terminate(input: {
    kind: TerminationKind;
    settlementId: string;
    customerId?: string | undefined;
    now: Date;
  }): Promise<OrphanSettlementTerminationResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const settlement = await repos.orphanSettlements.lockForUpdate(
        input.settlementId,
      );

      if (
        !settlement ||
        (input.customerId !== undefined &&
          settlement.customerId !== input.customerId)
      ) {
        throw new AppError(
          'Orphan settlement not found.',
          404,
          'ORPHAN_SETTLEMENT_NOT_FOUND',
        );
      }

      if (input.kind === 'expired' && settlement.expiresAt > input.now) {
        throw new AppError(
          'The settlement reservation has not expired.',
          409,
          'ORPHAN_SETTLEMENT_NOT_EXPIRED',
        );
      }

      const terminalStatus =
        input.kind === 'cancelled' ? 'cancelled' : 'expired';
      if (settlement.status === terminalStatus) {
        const claim = await repos.orphanRewardClaims.lockForUpdate(
          settlement.claimId,
        );
        if (!claim) {
          throw new AppError(
            'Settlement claim state is missing.',
            409,
            'ORPHAN_SETTLEMENT_STATE_CONFLICT',
          );
        }

        const event = await repos.orphanSettlementEvents.findByIdempotencyKey(
          this.eventKey(input.kind, settlement.id),
        );
        this.assertTerminationEvent(event, settlement, claim, input.kind);

        return {
          claim,
          settlement,
          event: event!,
          changed: false,
          claimReleased: claim.status === 'available',
        };
      }

      if (
        !['proposed', 'accepted', 'reserved', 'completion_authorized'].includes(
          settlement.status,
        )
      ) {
        throw new AppError(
          'The settlement can no longer be cancelled or expired.',
          409,
          'ORPHAN_SETTLEMENT_TERMINATION_NOT_ALLOWED',
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

      const needsRelease =
        settlement.status === 'accepted' ||
        settlement.status === 'reserved' ||
        settlement.status === 'completion_authorized';

      if (needsRelease) {
        if (claim.status !== 'reserved') {
          throw new AppError(
            'The orphan claim is not reserved by this settlement.',
            409,
            'ORPHAN_SETTLEMENT_STATE_CONFLICT',
          );
        }
        await this.assertClaimReleasable(repos, claim, input.now);
      } else if (claim.status !== 'available') {
        throw new AppError(
          'A proposed settlement must not hold a reserved claim.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      await this.revokeActiveAuthorization(
        repos,
        settlement.accessAuthorizationId,
        settlement.customerId,
      );
      if (settlement.completionAuthorizationId !== null) {
        await this.revokeActiveAuthorization(
          repos,
          settlement.completionAuthorizationId,
          settlement.customerId,
        );
      }

      const terminated = await repos.orphanSettlements.terminatePreFulfillment(
        settlement.id,
        terminalStatus,
      );
      if (!terminated) {
        throw new AppError(
          'The settlement could not transition to its terminal state.',
          409,
          'ORPHAN_SETTLEMENT_STATE_CONFLICT',
        );
      }

      let releasedClaim = claim;
      if (needsRelease) {
        const released = await repos.orphanRewardClaims.releaseReserved(
          claim.id,
        );
        if (!released) {
          throw new AppError(
            'The reserved claim could not be released.',
            409,
            'ORPHAN_SETTLEMENT_STATE_CONFLICT',
          );
        }
        releasedClaim = released;
      }

      const eventResult =
        await repos.orphanSettlementEvents.appendIdempotent({
          claimId: releasedClaim.id,
          settlementId: terminated.id,
          customerId: terminated.customerId,
          eventType:
            input.kind === 'cancelled'
              ? 'settlement_cancelled'
              : 'settlement_expired',
          originBusinessId: releasedClaim.originBusinessId,
          receivingBusinessId: terminated.receivingBusinessId,
          ...(terminated.receivingBranchId !== null
            ? { receivingBranchId: terminated.receivingBranchId }
            : {}),
          customerActionAuthorizationId:
            terminated.completionAuthorizationId ??
            terminated.accessAuthorizationId,
          idempotencyKey: this.eventKey(input.kind, terminated.id),
          metadata: {
            claimReleased: needsRelease,
            previousSettlementStatus: settlement.status,
          },
        });

      this.assertTerminationEvent(
        eventResult.event,
        terminated,
        releasedClaim,
        input.kind,
      );

      return {
        claim: releasedClaim,
        settlement: terminated,
        event: eventResult.event,
        changed: true,
        claimReleased: needsRelease,
      };
    });
  }

  private async assertClaimReleasable(
    repos: ReturnType<typeof createRepositories>,
    claim: OrphanRewardClaim,
    now: Date,
  ): Promise<void> {
    const source = await repos.loyaltyTransactions.lockForUpdate(
      claim.originLoyaltyTransactionId,
    );

    if (
      !source ||
      source.type !== 'redemption' ||
      source.issuanceStatus !== 'issued' ||
      source.redemptionConfirmedAt !== null ||
      source.relatedRewardId === null ||
      source.relatedRewardId !== claim.originRewardId
    ) {
      throw new AppError(
        'The source entitlement is no longer releasable under the frozen orphan qualification rules.',
        409,
        'ORPHAN_CLAIM_NOT_RELEASABLE',
      );
    }

    const account = await repos.loyaltyAccounts.findById(
      source.loyaltyAccountId,
      claim.originBusinessId,
    );
    if (
      !account ||
      account.id !== claim.originLoyaltyAccountId ||
      account.customerId !== claim.customerId ||
      account.businessId !== claim.originBusinessId
    ) {
      throw new AppError(
        'The source entitlement mapping is no longer valid.',
        409,
        'ORPHAN_CLAIM_NOT_RELEASABLE',
      );
    }

    const snapshotExpiry = claim.sourceRewardSnapshot.expiryDate;
    if (
      typeof snapshotExpiry === 'string' &&
      new Date(snapshotExpiry) <= now
    ) {
      throw new AppError(
        'The orphan claim source entitlement has expired and requires explicit claim-expiry policy.',
        409,
        'ORPHAN_CLAIM_NOT_RELEASABLE',
      );
    }

    if (claim.orphanReason === 'origin_business_archived') {
      const business = await repos.businesses.findById(
        claim.originBusinessId,
      );
      if (!business || business.status !== 'archived') {
        throw new AppError(
          'The origin business no longer satisfies the archived orphaning condition.',
          409,
          'ORPHAN_CLAIM_NOT_RELEASABLE',
        );
      }
    }
    // platform_unable_to_honor remains valid based on its original durable
    // administrator-qualified claim. Requiring a new admin actor here would
    // reinterpret the already-created claim rather than revalidate it.
  }

  private async revokeActiveAuthorization(
    repos: ReturnType<typeof createRepositories>,
    authorizationId: string,
    customerId: string,
  ): Promise<void> {
    const authorization =
      await repos.customerActionAuthorizations.findById(authorizationId);
    if (
      authorization &&
      authorization.customerId === customerId &&
      authorization.status === 'active'
    ) {
      await repos.customerActionAuthorizations.revoke(
        authorizationId,
        customerId,
      );
    }
  }

  private eventKey(kind: TerminationKind, settlementId: string): string {
    return kind === 'cancelled'
      ? `settlement-cancelled:${settlementId}`
      : `settlement-expired:${settlementId}`;
  }

  private assertTerminationEvent(
    event: OrphanSettlementEvent | undefined,
    settlement: OrphanSettlement,
    claim: OrphanRewardClaim,
    kind: TerminationKind,
  ): void {
    const expectedType =
      kind === 'cancelled'
        ? 'settlement_cancelled'
        : 'settlement_expired';

    if (
      !event ||
      event.eventType !== expectedType ||
      event.settlementId !== settlement.id ||
      event.claimId !== claim.id ||
      event.customerId !== settlement.customerId ||
      event.originBusinessId !== claim.originBusinessId ||
      event.receivingBusinessId !== settlement.receivingBusinessId ||
      event.receivingBranchId !== settlement.receivingBranchId
    ) {
      throw new AppError(
        'Settlement termination history conflicts with terminal state.',
        409,
        'ORPHAN_SETTLEMENT_EVENT_CONFLICT',
      );
    }
  }
}
