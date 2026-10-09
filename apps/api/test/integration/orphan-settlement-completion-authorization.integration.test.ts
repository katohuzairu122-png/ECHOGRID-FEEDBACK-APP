import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { OrphanQualificationService } from '../../src/orphan-settlement/orphan-qualification.service';
import { CustomerOrphanAccessService } from '../../src/orphan-settlement/customer-orphan-access.service';
import {
  ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
  ReceivingBusinessSettlementService,
} from '../../src/orphan-settlement/receiving-business-settlement.service';
import { CustomerSettlementCompletionService } from '../../src/orphan-settlement/customer-settlement-completion.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 customer completion authorization (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let originBusinessId: string;
    let receivingBusinessId: string;
    let receivingBranchId: string;
    let actorUserId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      originBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Completion Origin',
          slug: `split06-completion-origin-${suffix}`,
          status: 'archived',
        })
      ).id;

      receivingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Completion Receiver',
          slug: `split06-completion-receiver-${suffix}`,
          status: 'active',
        })
      ).id;

      receivingBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Completion Branch',
          slug: `split06-completion-branch-${suffix}`,
        })
      ).id;

      actorUserId = (
        await repos.users.create({
          email: `split06-completion-actor-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Completion Manager',
          status: 'active',
        })
      ).id;
    });

    afterAll(async () => {
      await client.end();
    });

    async function createReservedSettlement() {
      const customer = await repos.customers.create({
        phone: `+1597${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-completion-test',
      });

      const account = await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 80,
      });

      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Completion voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '20.00',
        description: 'Historical orphanable completion voucher',
        status: 'active',
      });

      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -20,
        relatedRewardId: reward.id,
        redemptionCode: `S06C-${crypto.randomUUID()}`,
        issuanceStatus: 'issued',
      });

      const qualified = await new OrphanQualificationService(db).qualify({
        sourceTransactionId: source.id,
        customerId: customer.id,
        originBusinessId,
        orphanReason: 'origin_business_archived',
      });

      const proposal = await new CustomerOrphanAccessService(db).authorizeAccess(
        customer.id,
        qualified.claim.id,
        {
          receivingBusinessId,
          consentVersion: 'settlement-v1',
          correlationId: `access-${crypto.randomUUID()}`,
          idempotencyKey: `proposal-${crypto.randomUUID()}`,
        },
      );

      const fulfillment = {
        benefitType: 'voucher' as const,
        title: 'Receiving-business replacement voucher',
        description: 'One replacement voucher for this orphan settlement.',
        terms: 'Single use at the accepting branch.',
        reference: `offer-${crypto.randomUUID()}`,
      };

      const accepted =
        await new ReceivingBusinessSettlementService(db).acceptAndReserve({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId,
          settlementId: proposal.settlement.id,
          acceptance: {
            authorizationId: proposal.authorization.id,
            fulfillment,
          },
        });

      return {
        customerId: customer.id,
        account,
        claim: qualified.claim,
        proposal,
        accepted,
        fulfillment,
      };
    }

    function completionInput(reference: string) {
      return {
        correlationId: `completion-${crypto.randomUUID()}`,
        idempotencyKey: `completion-${crypto.randomUUID()}`,
        fulfillmentPolicyVersion:
          ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
        fulfillmentReference: reference,
      };
    }

    it('shows the owning customer the exact reserved fulfillment contract and hides another customer', async () => {
      const fixture = await createReservedSettlement();
      const service = new CustomerSettlementCompletionService(db);

      const review = await service.getReview(
        fixture.customerId,
        fixture.accepted.settlement.id,
      );

      expect(review.settlement.status).toBe('reserved');
      expect(review.settlement.fulfillmentPolicyVersion).toBe(
        ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
      );
      expect(review.settlement.fulfillmentReference).toBe(
        fixture.fulfillment.reference,
      );
      expect(review.settlement.fulfillmentSnapshot).toEqual({
        benefitType: 'voucher',
        title: fixture.fulfillment.title,
        description: fixture.fulfillment.description,
        terms: fixture.fulfillment.terms,
      });

      const otherCustomer = await repos.customers.create({
        phone: `+1596${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      await expect(
        service.getReview(
          otherCustomer.id,
          fixture.accepted.settlement.id,
        ),
      ).rejects.toMatchObject({
        status: 404,
        code: 'ORPHAN_SETTLEMENT_NOT_FOUND',
      });
    });

    it('issues a settlement-scoped single-use completion authorization without consuming it and appends completion_authorized exactly once', async () => {
      const fixture = await createReservedSettlement();
      const service = new CustomerSettlementCompletionService(db);
      const input = completionInput(fixture.fulfillment.reference);

      const result = await service.authorizeCompletion(
        fixture.customerId,
        fixture.accepted.settlement.id,
        input,
      );

      expect(result.changed).toBe(true);
      expect(result.settlement.status).toBe('completion_authorized');
      expect(result.settlement.completionAuthorizationId).toBe(
        result.authorization.id,
      );
      expect(result.settlement.completionAuthorizedAt).not.toBeNull();

      expect(result.authorization.actionType).toBe('complete_settlement');
      expect(result.authorization.customerId).toBe(fixture.customerId);
      expect(result.authorization.businessId).toBe(receivingBusinessId);
      expect(result.authorization.resourceType).toBe('orphan_settlement');
      expect(result.authorization.resourceId).toBe(
        fixture.accepted.settlement.id,
      );
      expect(result.authorization.scope).toBe(
        `settlement_completion:claim:${fixture.claim.id}`,
      );
      expect(result.authorization.status).toBe('active');
      expect(result.authorization.consumedAt).toBeNull();
      expect(result.authorization.expiresAt.getTime()).toBeLessThanOrEqual(
        fixture.accepted.settlement.expiresAt.getTime(),
      );

      expect(result.event.eventType).toBe('completion_authorized');
      expect(result.event.customerActionAuthorizationId).toBe(
        result.authorization.id,
      );
      expect(result.event.actorUserId).toBeNull();

      const replay = await service.authorizeCompletion(
        fixture.customerId,
        fixture.accepted.settlement.id,
        input,
      );
      expect(replay.changed).toBe(false);
      expect(replay.authorization.id).toBe(result.authorization.id);
      expect(replay.event.id).toBe(result.event.id);

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.accepted.settlement.id,
      );
      expect(
        events.filter(
          (event) => event.eventType === 'completion_authorized',
        ),
      ).toHaveLength(1);
    });

    it('rejects stale fulfillment acknowledgement and revoked settlement access consent', async () => {
      const stale = await createReservedSettlement();
      const service = new CustomerSettlementCompletionService(db);

      await expect(
        service.authorizeCompletion(
          stale.customerId,
          stale.accepted.settlement.id,
          {
            ...completionInput(stale.fulfillment.reference),
            fulfillmentReference: 'different-offer',
          },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_FULFILLMENT_ACKNOWLEDGEMENT_STALE',
      });

      const revoked = await createReservedSettlement();
      await repos.consentGrants.revoke(
        revoked.proposal.consent.id,
        revoked.customerId,
      );

      await expect(
        service.authorizeCompletion(
          revoked.customerId,
          revoked.accepted.settlement.id,
          completionInput(revoked.fulfillment.reference),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_CONSENT_INACTIVE',
      });

      expect(
        (await repos.orphanSettlements.findById(
          revoked.accepted.settlement.id,
        ))?.status,
      ).toBe('reserved');
    });

    it('will not overwrite a live completion authorization but permits explicit reauthorization after revocation', async () => {
      const fixture = await createReservedSettlement();
      const service = new CustomerSettlementCompletionService(db);
      const firstInput = completionInput(fixture.fulfillment.reference);
      const first = await service.authorizeCompletion(
        fixture.customerId,
        fixture.accepted.settlement.id,
        firstInput,
      );

      await expect(
        service.authorizeCompletion(
          fixture.customerId,
          fixture.accepted.settlement.id,
          completionInput(fixture.fulfillment.reference),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_COMPLETION_ALREADY_AUTHORIZED',
      });

      await repos.customerActionAuthorizations.revoke(
        first.authorization.id,
        fixture.customerId,
      );

      const second = await service.authorizeCompletion(
        fixture.customerId,
        fixture.accepted.settlement.id,
        completionInput(fixture.fulfillment.reference),
      );

      expect(second.changed).toBe(true);
      expect(second.authorization.id).not.toBe(first.authorization.id);
      expect(second.authorization.status).toBe('active');
      expect(second.settlement.completionAuthorizationId).toBe(
        second.authorization.id,
      );

      expect(
        (
          await repos.customerActionAuthorizations.findById(
            first.authorization.id,
          )
        )?.status,
      ).toBe('revoked');

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.accepted.settlement.id,
      );
      expect(
        events.filter(
          (event) => event.eventType === 'completion_authorized',
        ),
      ).toHaveLength(2);
    });

    it('cannot reuse one completion idempotency key across another settlement or claim', async () => {
      const first = await createReservedSettlement();
      const second = await createReservedSettlement();
      const service = new CustomerSettlementCompletionService(db);
      const sharedInput = completionInput(first.fulfillment.reference);

      await service.authorizeCompletion(
        first.customerId,
        first.accepted.settlement.id,
        sharedInput,
      );

      await expect(
        service.authorizeCompletion(
          second.customerId,
          second.accepted.settlement.id,
          {
            ...sharedInput,
            fulfillmentReference: second.fulfillment.reference,
          },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_COMPLETION_IDEMPOTENCY_CONFLICT',
      });

      expect(
        (await repos.orphanSettlements.findById(
          second.accepted.settlement.id,
        ))?.status,
      ).toBe('reserved');
    });

    it('does not mutate business loyalty or Community Point ledgers during completion authorization', async () => {
      const fixture = await createReservedSettlement();
      const loyaltyBefore = await repos.loyaltyTransactions.listForAccount(
        fixture.account.id,
      );
      const communityAccount =
        await repos.communityPointAccounts.findByCustomerId(
          fixture.customerId,
        );
      const communityBefore = communityAccount
        ? await repos.communityPointTransactions.listForAccount(
            communityAccount.id,
          )
        : [];

      await new CustomerSettlementCompletionService(db).authorizeCompletion(
        fixture.customerId,
        fixture.accepted.settlement.id,
        completionInput(fixture.fulfillment.reference),
      );

      expect(
        await repos.loyaltyTransactions.listForAccount(fixture.account.id),
      ).toEqual(loyaltyBefore);

      const communityAfter =
        await repos.communityPointAccounts.findByCustomerId(
          fixture.customerId,
        );
      expect(communityAfter).toEqual(communityAccount);

      if (communityAfter) {
        expect(
          await repos.communityPointTransactions.listForAccount(
            communityAfter.id,
          ),
        ).toEqual(communityBefore);
      }
    });
  },
);
