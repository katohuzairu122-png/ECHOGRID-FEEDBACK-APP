import type {
  OrphanSettlementAccessAuthorizationInput,
} from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import {
  createRepositories,
  type ConsentGrant,
  type CustomerActionAuthorization,
  type OrphanRewardClaim,
  type OrphanSettlement,
  type OrphanSettlementEvent,
} from '../repositories';
import { AppError } from '../lib/errors';

const ACCESS_AUTH_TTL_SECONDS = 5 * 60;
const CLAIM_RESOURCE_TYPE = 'orphan_reward_claim';
const CLAIM_ACCESS_SCOPE = 'settlement_access:claim';

export interface CustomerOrphanAccessResult {
  claim: OrphanRewardClaim;
  consent: ConsentGrant;
  authorization: CustomerActionAuthorization;
  settlement: OrphanSettlement;
  event: OrphanSettlementEvent;
  changed: boolean;
}

export class CustomerOrphanAccessService {
  constructor(private readonly db: Database) {}

  async listClaims(
    customerId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<OrphanRewardClaim[]> {
    return createRepositories(this.db).orphanRewardClaims.listForCustomer(
      customerId,
      options,
    );
  }

  async getClaim(
    customerId: string,
    claimId: string,
  ): Promise<OrphanRewardClaim> {
    const claim =
      await createRepositories(this.db).orphanRewardClaims.findByIdForCustomer(
        claimId,
        customerId,
      );
    if (!claim) {
      throw new AppError(
        'Orphan reward claim not found.',
        404,
        'ORPHAN_CLAIM_NOT_FOUND',
      );
    }
    return claim;
  }

  async authorizeAccess(
    customerId: string,
    claimId: string,
    input: OrphanSettlementAccessAuthorizationInput,
  ): Promise<CustomerOrphanAccessResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const claim = await repos.orphanRewardClaims.findByIdForCustomer(
        claimId,
        customerId,
      );
      if (!claim) {
        throw new AppError(
          'Orphan reward claim not found.',
          404,
          'ORPHAN_CLAIM_NOT_FOUND',
        );
      }

      if (claim.status !== 'available') {
        throw new AppError(
          'Only an available orphan claim can authorize settlement access.',
          409,
          'ORPHAN_CLAIM_NOT_AVAILABLE',
        );
      }

      if (input.receivingBusinessId === claim.originBusinessId) {
        throw new AppError(
          'The origin business cannot receive its own orphan settlement.',
          409,
          'ORPHAN_RECEIVING_BUSINESS_INVALID',
        );
      }

      const receivingBusiness = await repos.businesses.findById(
        input.receivingBusinessId,
      );
      if (!receivingBusiness || receivingBusiness.status !== 'active') {
        throw new AppError(
          'The receiving business is not eligible for settlement access.',
          409,
          'ORPHAN_RECEIVING_BUSINESS_INVALID',
        );
      }

      const consentKey = `orphan-access-consent:${input.idempotencyKey}`;
      const existingConsent =
        await repos.consentGrants.findActiveForResource(
          customerId,
          input.receivingBusinessId,
          'settlement_access',
          CLAIM_RESOURCE_TYPE,
          claim.id,
        );

      const consent =
        existingConsent?.consentVersion === input.consentVersion
          ? existingConsent
          : await repos.consentGrants.create({
              customerId,
              businessId: input.receivingBusinessId,
              purpose: 'settlement_access',
              consentVersion: input.consentVersion,
              scope: CLAIM_ACCESS_SCOPE,
              resourceType: CLAIM_RESOURCE_TYPE,
              resourceId: claim.id,
              idempotencyKey: consentKey,
            });

      this.assertConsentMatches(consent, {
        customerId,
        businessId: input.receivingBusinessId,
        claimId: claim.id,
        consentVersion: input.consentVersion,
      });

      const authorizationKey = `orphan-access-auth:${input.idempotencyKey}`;
      const authorization = await repos.customerActionAuthorizations.create({
        customerId,
        businessId: input.receivingBusinessId,
        actionType: 'access_orphan_settlement',
        correlationId: input.correlationId,
        expiresAt: new Date(Date.now() + ACCESS_AUTH_TTL_SECONDS * 1000),
        resourceType: CLAIM_RESOURCE_TYPE,
        resourceId: claim.id,
        scope: CLAIM_ACCESS_SCOPE,
        idempotencyKey: authorizationKey,
      });

      this.assertAuthorizationMatches(authorization, {
        customerId,
        businessId: input.receivingBusinessId,
        claimId: claim.id,
        correlationId: input.correlationId,
      });

      const settlementKey = `orphan-access-settlement:${input.idempotencyKey}`;
      const settlementResult = await repos.orphanSettlements.createIdempotent({
        claimId: claim.id,
        customerId,
        receivingBusinessId: input.receivingBusinessId,
        status: 'proposed',
        accessAuthorizationId: authorization.id,
        expiresAt: authorization.expiresAt,
        idempotencyKey: settlementKey,
      });

      this.assertSettlementMatches(settlementResult.settlement, {
        customerId,
        claimId: claim.id,
        businessId: input.receivingBusinessId,
        authorizationId: authorization.id,
      });

      const eventResult = await repos.orphanSettlementEvents.appendIdempotent({
        claimId: claim.id,
        settlementId: settlementResult.settlement.id,
        customerId,
        eventType: 'partner_selected',
        originBusinessId: claim.originBusinessId,
        receivingBusinessId: input.receivingBusinessId,
        customerActionAuthorizationId: authorization.id,
        idempotencyKey: `partner-selected:${settlementResult.settlement.id}`,
        metadata: {
          consentGrantId: consent.id,
          correlationId: input.correlationId,
        },
      });

      if (
        eventResult.event.claimId !== claim.id ||
        eventResult.event.settlementId !== settlementResult.settlement.id ||
        eventResult.event.customerId !== customerId ||
        eventResult.event.receivingBusinessId !== input.receivingBusinessId ||
        eventResult.event.customerActionAuthorizationId !== authorization.id ||
        eventResult.event.eventType !== 'partner_selected'
      ) {
        throw new AppError(
          'The partner selection event conflicts with a previous request.',
          409,
          'ORPHAN_ACCESS_IDEMPOTENCY_CONFLICT',
        );
      }

      return {
        claim,
        consent,
        authorization,
        settlement: settlementResult.settlement,
        event: eventResult.event,
        changed: settlementResult.inserted || eventResult.inserted,
      };
    });
  }

  private assertConsentMatches(
    consent: ConsentGrant,
    expected: {
      customerId: string;
      businessId: string;
      claimId: string;
      consentVersion: string;
    },
  ): void {
    if (
      consent.customerId !== expected.customerId ||
      consent.businessId !== expected.businessId ||
      consent.purpose !== 'settlement_access' ||
      consent.resourceType !== CLAIM_RESOURCE_TYPE ||
      consent.resourceId !== expected.claimId ||
      consent.scope !== CLAIM_ACCESS_SCOPE ||
      consent.consentVersion !== expected.consentVersion
    ) {
      throw new AppError(
        'The consent idempotency key conflicts with another settlement scope.',
        409,
        'ORPHAN_ACCESS_IDEMPOTENCY_CONFLICT',
      );
    }
  }

  private assertAuthorizationMatches(
    authorization: CustomerActionAuthorization,
    expected: {
      customerId: string;
      businessId: string;
      claimId: string;
      correlationId: string;
    },
  ): void {
    if (
      authorization.customerId !== expected.customerId ||
      authorization.businessId !== expected.businessId ||
      authorization.actionType !== 'access_orphan_settlement' ||
      authorization.resourceType !== CLAIM_RESOURCE_TYPE ||
      authorization.resourceId !== expected.claimId ||
      authorization.scope !== CLAIM_ACCESS_SCOPE ||
      authorization.correlationId !== expected.correlationId
    ) {
      throw new AppError(
        'The authorization idempotency key conflicts with another settlement scope.',
        409,
        'ORPHAN_ACCESS_IDEMPOTENCY_CONFLICT',
      );
    }
  }

  private assertSettlementMatches(
    settlement: OrphanSettlement,
    expected: {
      customerId: string;
      claimId: string;
      businessId: string;
      authorizationId: string;
    },
  ): void {
    if (
      settlement.customerId !== expected.customerId ||
      settlement.claimId !== expected.claimId ||
      settlement.receivingBusinessId !== expected.businessId ||
      settlement.accessAuthorizationId !== expected.authorizationId
    ) {
      throw new AppError(
        'The settlement idempotency key conflicts with another settlement scope.',
        409,
        'ORPHAN_ACCESS_IDEMPOTENCY_CONFLICT',
      );
    }
  }
}
