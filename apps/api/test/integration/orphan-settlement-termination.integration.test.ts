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
import { OrphanSettlementTerminationService } from '../../src/orphan-settlement/orphan-settlement-termination.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 reservation expiry and cancellation (integration)',
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
          name: 'Split 06 Termination Origin',
          slug: `split06-termination-origin-${suffix}`,
          status: 'archived',
        })
      ).id;

      receivingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Termination Receiver',
          slug: `split06-termination-receiver-${suffix}`,
          status: 'active',
        })
      ).id;

      receivingBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Termination Branch',
          slug: `split06-termination-branch-${suffix}`,
        })
      ).id;

      actorUserId = (
        await repos.users.create({
          email: `split06-termination-actor-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Termination Manager',
          status: 'active',
        })
      ).id;
    });

    afterAll(async () => {
      await client.end();
    });

    async function createProposal() {
      const customer = await repos.customers.create({
        phone: `+1594${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-termination-test',
      });

      const account = await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 100,
      });

      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Termination voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '30.00',
        description: 'Historical orphanable termination voucher',
        status: 'active',
      });

      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -30,
        relatedRewardId: reward.id,
        redemptionCode: `S06X-${crypto.randomUUID()}`,
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
          correlationId: `termination-access-${crypto.randomUUID()}`,
          idempotencyKey: `termination-proposal-${crypto.randomUUID()}`,
        },
      );

      return {
        customerId: customer.id,
        account,
        source,
        claim: qualified.claim,
        proposal,
      };
    }

    async function reserve(
      fixture: Awaited<ReturnType<typeof createProposal>>,
    ) {
      const fulfillment = {
        benefitType: 'voucher' as const,
        title: 'Termination replacement voucher',
        description: 'One replacement voucher for this orphan settlement.',
        terms: 'Valid once at the accepting branch.',
        reference: `termination-offer-${crypto.randomUUID()}`,
      };

      const accepted =
        await new ReceivingBusinessSettlementService(db).acceptAndReserve({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId,
          settlementId: fixture.proposal.settlement.id,
          acceptance: {
            authorizationId: fixture.proposal.authorization.id,
            fulfillment,
          },
        });

      return { ...fixture, accepted, fulfillment };
    }

    async function authorizeCompletion(
      fixture: Awaited<ReturnType<typeof reserve>>,
    ) {
      const completion =
        await new CustomerSettlementCompletionService(db).authorizeCompletion(
          fixture.customerId,
          fixture.accepted.settlement.id,
          {
            correlationId: `termination-complete-${crypto.randomUUID()}`,
            idempotencyKey: `termination-complete-${crypto.randomUUID()}`,
            fulfillmentPolicyVersion:
              ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
            fulfillmentReference: fixture.fulfillment.reference,
          },
        );

      return { ...fixture, completion };
    }

    it('cancels a proposed settlement without reserving the claim and revokes active access authorization', async () => {
      const fixture = await createProposal();
      const service = new OrphanSettlementTerminationService(db);

      const result = await service.cancelForCustomer(
        fixture.customerId,
        fixture.proposal.settlement.id,
      );

      expect(result.changed).toBe(true);
      expect(result.settlement.status).toBe('cancelled');
      expect(result.claim.status).toBe('available');
      expect(result.claimReleased).toBe(false);
      expect(result.event.eventType).toBe('settlement_cancelled');

      expect(
        (
          await repos.customerActionAuthorizations.findById(
            fixture.proposal.authorization.id,
          )
        )?.status,
      ).toBe('revoked');
    });

    it('cancels a reserved settlement and releases the still-valid claim', async () => {
      const fixture = await reserve(await createProposal());
      const service = new OrphanSettlementTerminationService(db);

      const result = await service.cancelForCustomer(
        fixture.customerId,
        fixture.accepted.settlement.id,
      );

      expect(result.settlement.status).toBe('cancelled');
      expect(result.claim.status).toBe('available');
      expect(result.claimReleased).toBe(true);

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.accepted.settlement.id,
      );
      expect(
        events.filter((event) => event.eventType === 'settlement_cancelled'),
      ).toHaveLength(1);
    });

    it('cancels a completion-authorized settlement, revokes completion authority, and releases the claim', async () => {
      const fixture = await authorizeCompletion(
        await reserve(await createProposal()),
      );
      const service = new OrphanSettlementTerminationService(db);

      const result = await service.cancelForCustomer(
        fixture.customerId,
        fixture.accepted.settlement.id,
      );

      expect(result.settlement.status).toBe('cancelled');
      expect(result.claim.status).toBe('available');
      expect(result.claimReleased).toBe(true);
      expect(
        (
          await repos.customerActionAuthorizations.findById(
            fixture.completion.authorization.id,
          )
        )?.status,
      ).toBe('revoked');
    });

    it('expires a due reserved settlement, releases the valid claim, and is exactly replay-safe', async () => {
      const fixture = await reserve(await createProposal());
      const service = new OrphanSettlementTerminationService(db);
      const afterExpiry = new Date(
        fixture.accepted.settlement.expiresAt.getTime() + 1,
      );

      const first = await service.expireSettlement(
        fixture.accepted.settlement.id,
        afterExpiry,
      );
      const replay = await service.expireSettlement(
        fixture.accepted.settlement.id,
        afterExpiry,
      );

      expect(first.changed).toBe(true);
      expect(first.settlement.status).toBe('expired');
      expect(first.claim.status).toBe('available');
      expect(first.claimReleased).toBe(true);

      expect(replay.changed).toBe(false);
      expect(replay.event.id).toBe(first.event.id);

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.accepted.settlement.id,
      );
      expect(
        events.filter((event) => event.eventType === 'settlement_expired'),
      ).toHaveLength(1);
    });

    it('rejects expiry before the reservation deadline', async () => {
      const fixture = await reserve(await createProposal());

      await expect(
        new OrphanSettlementTerminationService(db).expireSettlement(
          fixture.accepted.settlement.id,
          new Date(fixture.accepted.settlement.expiresAt.getTime() - 1),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_NOT_EXPIRED',
      });
    });

    it('fails closed instead of reopening a reserved claim whose source entitlement is no longer outstanding', async () => {
      const fixture = await reserve(await createProposal());
      await repos.loyaltyTransactions.confirmRedemption(fixture.source.id);

      await expect(
        new OrphanSettlementTerminationService(db).cancelForCustomer(
          fixture.customerId,
          fixture.accepted.settlement.id,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_CLAIM_NOT_RELEASABLE',
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

    it('does not cancel fulfilled settlements', async () => {
      const fixture = await authorizeCompletion(
        await reserve(await createProposal()),
      );
      const { OrphanSettlementFulfillmentService } = await import(
        '../../src/orphan-settlement/orphan-settlement-fulfillment.service'
      );

      await new OrphanSettlementFulfillmentService(db).fulfill({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: fixture.accepted.settlement.id,
      });

      await expect(
        new OrphanSettlementTerminationService(db).cancelForCustomer(
          fixture.customerId,
          fixture.accepted.settlement.id,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_TERMINATION_NOT_ALLOWED',
      });
    });

    it('does not mutate business loyalty or Community Point ledgers during cancellation', async () => {
      const fixture = await reserve(await createProposal());
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

      await new OrphanSettlementTerminationService(db).cancelForCustomer(
        fixture.customerId,
        fixture.accepted.settlement.id,
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
