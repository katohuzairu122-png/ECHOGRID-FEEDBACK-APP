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
import { OrphanSettlementFulfillmentService } from '../../src/orphan-settlement/orphan-settlement-fulfillment.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 terminal settlement fulfillment and evidence (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let originBusinessId: string;
    let receivingBusinessId: string;
    let competingBusinessId: string;
    let receivingBranchId: string;
    let otherBranchId: string;
    let actorUserId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      originBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Terminal Origin',
          slug: `split06-terminal-origin-${suffix}`,
          status: 'archived',
        })
      ).id;

      receivingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Terminal Receiver',
          slug: `split06-terminal-receiver-${suffix}`,
          status: 'active',
        })
      ).id;

      competingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Terminal Competitor',
          slug: `split06-terminal-competitor-${suffix}`,
          status: 'active',
        })
      ).id;

      receivingBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Terminal Branch A',
          slug: `split06-terminal-a-${suffix}`,
        })
      ).id;

      otherBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Terminal Branch B',
          slug: `split06-terminal-b-${suffix}`,
        })
      ).id;

      actorUserId = (
        await repos.users.create({
          email: `split06-terminal-actor-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Terminal Manager',
          status: 'active',
        })
      ).id;
    });

    afterAll(async () => {
      await client.end();
    });

    async function createReservedSettlement() {
      const customer = await repos.customers.create({
        phone: `+1595${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-terminal-test',
      });

      const account = await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 90,
      });

      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Terminal voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '25.00',
        description: 'Historical orphanable terminal voucher',
        status: 'active',
      });

      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -25,
        relatedRewardId: reward.id,
        redemptionCode: `S06T-${crypto.randomUUID()}`,
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
          correlationId: `terminal-access-${crypto.randomUUID()}`,
          idempotencyKey: `terminal-proposal-${crypto.randomUUID()}`,
        },
      );

      const fulfillment = {
        benefitType: 'voucher' as const,
        title: 'Terminal replacement voucher',
        description: 'One replacement voucher for this orphan settlement.',
        terms: 'Valid once at the accepting branch.',
        reference: `terminal-offer-${crypto.randomUUID()}`,
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

    async function authorizeCompletion(
      fixture: Awaited<ReturnType<typeof createReservedSettlement>>,
    ) {
      return new CustomerSettlementCompletionService(db).authorizeCompletion(
        fixture.customerId,
        fixture.accepted.settlement.id,
        {
          correlationId: `terminal-complete-${crypto.randomUUID()}`,
          idempotencyKey: `terminal-complete-${crypto.randomUUID()}`,
          fulfillmentPolicyVersion:
            ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
          fulfillmentReference: fixture.fulfillment.reference,
        },
      );
    }

    it('requires customer completion authorization before receiving-business fulfillment', async () => {
      const fixture = await createReservedSettlement();

      await expect(
        new OrphanSettlementFulfillmentService(db).fulfill({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId,
          settlementId: fixture.accepted.settlement.id,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_NOT_COMPLETION_AUTHORIZED',
      });

      expect(
        (await repos.orphanSettlements.findById(
          fixture.accepted.settlement.id,
        ))?.status,
      ).toBe('reserved');
      expect(
        (await repos.orphanRewardClaims.findById(fixture.claim.id))?.status,
      ).toBe('reserved');
    });

    it('consumes the exact completion authorization, settles both projections, appends terminal history, and emits value-neutral evidence', async () => {
      const fixture = await createReservedSettlement();
      const completion = await authorizeCompletion(fixture);
      const service = new OrphanSettlementFulfillmentService(db);

      const result = await service.fulfill({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: fixture.accepted.settlement.id,
      });

      expect(result.changed).toBe(true);
      expect(result.settlement.status).toBe('fulfilled');
      expect(result.settlement.fulfilledByUserId).toBe(actorUserId);
      expect(result.settlement.fulfilledAt).not.toBeNull();
      expect(result.claim.status).toBe('settled');
      expect(result.claim.settledAt?.toISOString()).toBe(
        result.settlement.fulfilledAt?.toISOString(),
      );

      const authorization =
        await repos.customerActionAuthorizations.findById(
          completion.authorization.id,
        );
      expect(authorization?.status).toBe('consumed');
      expect(authorization?.consumedAt).not.toBeNull();

      expect(result.settlementFulfilledEvent.eventType).toBe(
        'settlement_fulfilled',
      );
      expect(
        result.settlementFulfilledEvent.customerActionAuthorizationId,
      ).toBe(completion.authorization.id);
      expect(result.settlementFulfilledEvent.actorUserId).toBe(actorUserId);

      expect(result.evidence).toEqual({
        evidenceVersion: 'v1',
        settlementRef: result.settlement.id,
        claimId: result.claim.id,
        customerId: fixture.customerId,
        originBusinessId,
        receivingBusinessId,
        receivingBranchId,
        fulfilledAt: result.settlement.fulfilledAt?.toISOString(),
        fulfillmentPolicyVersion:
          ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
        fulfillmentReference: fixture.fulfillment.reference,
      });

      expect('partnerCreditAmount' in result.evidence).toBe(false);
      expect('subscriptionCreditAmount' in result.evidence).toBe(false);
      expect('stripeId' in result.evidence).toBe(false);
      expect('communityPointAmount' in result.evidence).toBe(false);

      const resolved = await service.getCompletionEvidence(
        result.settlement.id,
      );
      expect(resolved).toEqual(result.evidence);
    });

    it('is exactly replay-safe after terminal fulfillment and does not append a second fulfilled event', async () => {
      const fixture = await createReservedSettlement();
      await authorizeCompletion(fixture);
      const service = new OrphanSettlementFulfillmentService(db);

      const first = await service.fulfill({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: fixture.accepted.settlement.id,
      });
      const replay = await service.fulfill({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: fixture.accepted.settlement.id,
      });

      expect(replay.changed).toBe(false);
      expect(replay.settlement.id).toBe(first.settlement.id);
      expect(replay.claim.id).toBe(first.claim.id);
      expect(replay.settlementFulfilledEvent.id).toBe(
        first.settlementFulfilledEvent.id,
      );
      expect(replay.evidence).toEqual(first.evidence);

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.accepted.settlement.id,
      );
      expect(
        events.filter((event) => event.eventType === 'settlement_fulfilled'),
      ).toHaveLength(1);
    });

    it('rejects revoked completion authorization and preserves the completion-authorized reservation', async () => {
      const fixture = await createReservedSettlement();
      const completion = await authorizeCompletion(fixture);
      await repos.customerActionAuthorizations.revoke(
        completion.authorization.id,
        fixture.customerId,
      );

      await expect(
        new OrphanSettlementFulfillmentService(db).fulfill({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId,
          settlementId: fixture.accepted.settlement.id,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_COMPLETION_AUTHORIZATION_INVALID',
      });

      expect(
        (await repos.orphanSettlements.findById(
          fixture.accepted.settlement.id,
        ))?.status,
      ).toBe('completion_authorized');
      expect(
        (await repos.orphanRewardClaims.findById(fixture.claim.id))?.status,
      ).toBe('reserved');
    });

    it('enforces receiving business and exact trusted branch binding at fulfillment', async () => {
      const fixture = await createReservedSettlement();
      await authorizeCompletion(fixture);
      const service = new OrphanSettlementFulfillmentService(db);

      await expect(
        service.fulfill({
          businessId: competingBusinessId,
          actorUserId,
          settlementId: fixture.accepted.settlement.id,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'ORPHAN_SETTLEMENT_NOT_FOUND',
      });

      await expect(
        service.fulfill({
          businessId: receivingBusinessId,
          branchId: otherBranchId,
          actorUserId,
          settlementId: fixture.accepted.settlement.id,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ORPHAN_SETTLEMENT_BRANCH_MISMATCH',
      });
    });

    it('rolls back authorization consumption and terminal projections when append-only fulfilled history conflicts', async () => {
      const fixture = await createReservedSettlement();
      const completion = await authorizeCompletion(fixture);

      await repos.orphanSettlementEvents.appendIdempotent({
        claimId: fixture.claim.id,
        settlementId: fixture.accepted.settlement.id,
        customerId: fixture.customerId,
        eventType: 'settlement_fulfilled',
        originBusinessId,
        receivingBusinessId: competingBusinessId,
        actorUserId,
        customerActionAuthorizationId: completion.authorization.id,
        idempotencyKey: `settlement-fulfilled:${fixture.accepted.settlement.id}`,
      });

      await expect(
        new OrphanSettlementFulfillmentService(db).fulfill({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId,
          settlementId: fixture.accepted.settlement.id,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_EVENT_CONFLICT',
      });

      expect(
        (
          await repos.customerActionAuthorizations.findById(
            completion.authorization.id,
          )
        )?.status,
      ).toBe('active');
      expect(
        (await repos.orphanSettlements.findById(
          fixture.accepted.settlement.id,
        ))?.status,
      ).toBe('completion_authorized');
      expect(
        (await repos.orphanRewardClaims.findById(fixture.claim.id))?.status,
      ).toBe('reserved');
    });

    it('does not mutate origin loyalty or Community Point ledgers and does not create receiving-business loyalty state', async () => {
      const fixture = await createReservedSettlement();
      await authorizeCompletion(fixture);

      const originLoyaltyBefore =
        await repos.loyaltyTransactions.listForAccount(fixture.account.id);
      const receivingAccountBefore =
        await repos.loyaltyAccounts.findByCustomerAndBusiness(
          fixture.customerId,
          receivingBusinessId,
        );
      const communityAccountBefore =
        await repos.communityPointAccounts.findByCustomerId(
          fixture.customerId,
        );
      const communityTransactionsBefore = communityAccountBefore
        ? await repos.communityPointTransactions.listForAccount(
            communityAccountBefore.id,
          )
        : [];

      await new OrphanSettlementFulfillmentService(db).fulfill({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: fixture.accepted.settlement.id,
      });

      expect(
        await repos.loyaltyTransactions.listForAccount(fixture.account.id),
      ).toEqual(originLoyaltyBefore);
      expect(
        await repos.loyaltyAccounts.findByCustomerAndBusiness(
          fixture.customerId,
          receivingBusinessId,
        ),
      ).toEqual(receivingAccountBefore);

      const communityAccountAfter =
        await repos.communityPointAccounts.findByCustomerId(
          fixture.customerId,
        );
      expect(communityAccountAfter).toEqual(communityAccountBefore);
      if (communityAccountAfter) {
        expect(
          await repos.communityPointTransactions.listForAccount(
            communityAccountAfter.id,
          ),
        ).toEqual(communityTransactionsBefore);
      }
    });
  },
);
