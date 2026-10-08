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

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 receiving-business acceptance and reservation (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let originBusinessId: string;
    let receivingBusinessId: string;
    let competingBusinessId: string;
    let receivingBranchId: string;
    let otherReceivingBranchId: string;
    let actorUserId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      originBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Reservation Origin',
          slug: `split06-reservation-origin-${suffix}`,
          status: 'archived',
        })
      ).id;

      receivingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Receiving Business',
          slug: `split06-reservation-receiving-${suffix}`,
          status: 'active',
        })
      ).id;

      competingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Competing Business',
          slug: `split06-reservation-competing-${suffix}`,
          status: 'active',
        })
      ).id;

      receivingBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Receiving Branch A',
          slug: `split06-receiving-a-${suffix}`,
        })
      ).id;

      otherReceivingBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Receiving Branch B',
          slug: `split06-receiving-b-${suffix}`,
        })
      ).id;

      actorUserId = (
        await repos.users.create({
          email: `split06-reservation-actor-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Receiving Manager',
          status: 'active',
        })
      ).id;
    });

    afterAll(async () => {
      await client.end();
    });

    async function createClaim() {
      const customer = await repos.customers.create({
        phone: `+1598${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-reservation-test',
      });

      const account = await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 75,
      });

      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Reservation voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '15.00',
        description: 'Historical orphanable voucher',
        status: 'active',
      });

      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -15,
        relatedRewardId: reward.id,
        redemptionCode: `S06R-${crypto.randomUUID()}`,
        issuanceStatus: 'issued',
      });

      const qualified = await new OrphanQualificationService(db).qualify({
        sourceTransactionId: source.id,
        customerId: customer.id,
        originBusinessId,
        orphanReason: 'origin_business_archived',
      });

      return {
        customerId: customer.id,
        claim: qualified.claim,
        source,
        account,
      };
    }

    async function propose(
      customerId: string,
      claimId: string,
      receivingBusiness: string,
    ) {
      return new CustomerOrphanAccessService(db).authorizeAccess(
        customerId,
        claimId,
        {
          receivingBusinessId: receivingBusiness,
          consentVersion: 'settlement-v1',
          correlationId: `corr-${crypto.randomUUID()}`,
          idempotencyKey: `proposal-${crypto.randomUUID()}`,
        },
      );
    }

    const fulfillment = {
      benefitType: 'voucher' as const,
      title: 'Partner replacement voucher',
      description: 'One replacement voucher accepted for this orphan claim.',
      terms: 'Valid once at the accepting branch.',
      reference: 'manual-offer-v1',
    };

    it('exposes only minimum authorized claim data to the selected receiving business', async () => {
      const created = await createClaim();
      const proposal = await propose(
        created.customerId,
        created.claim.id,
        receivingBusinessId,
      );

      const view = await new ReceivingBusinessSettlementService(
        db,
      ).inspectAuthorizedClaim({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        access: {
          settlementId: proposal.settlement.id,
          authorizationId: proposal.authorization.id,
        },
      });

      expect(view.claim.sourceRewardType).toBe('voucher');
      expect(view.claim.reward.name).toContain('Reservation voucher');
      expect(view.claim.reward.value).toBe('15.00');
      expect(view.receivingBusinessId).toBe(receivingBusinessId);

      expect('customerId' in view).toBe(false);
      expect('originBusinessId' in view.claim).toBe(false);
      expect('originLoyaltyTransactionId' in view.claim).toBe(false);

      await expect(
        new ReceivingBusinessSettlementService(db).inspectAuthorizedClaim({
          businessId: competingBusinessId,
          access: {
            settlementId: proposal.settlement.id,
            authorizationId: proposal.authorization.id,
          },
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'ORPHAN_SETTLEMENT_NOT_FOUND',
      });
    });

    it('rejects revoked and expired access authorizations before inspection or acceptance', async () => {
      const revokedCase = await createClaim();
      const revokedProposal = await propose(
        revokedCase.customerId,
        revokedCase.claim.id,
        receivingBusinessId,
      );
      await repos.customerActionAuthorizations.revoke(
        revokedProposal.authorization.id,
        revokedCase.customerId,
      );

      await expect(
        new ReceivingBusinessSettlementService(db).inspectAuthorizedClaim({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          access: {
            settlementId: revokedProposal.settlement.id,
            authorizationId: revokedProposal.authorization.id,
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_ACCESS_INVALID',
      });

      const expiredCase = await createClaim();
      const expiredAuthorization =
        await repos.customerActionAuthorizations.create({
          customerId: expiredCase.customerId,
          businessId: receivingBusinessId,
          actionType: 'access_orphan_settlement',
          correlationId: `expired-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() - 60_000),
          resourceType: 'orphan_reward_claim',
          resourceId: expiredCase.claim.id,
          scope: 'settlement_access:claim',
          idempotencyKey: `expired-auth-${crypto.randomUUID()}`,
        });

      const expiredSettlement = await repos.orphanSettlements.createIdempotent({
        claimId: expiredCase.claim.id,
        customerId: expiredCase.customerId,
        receivingBusinessId,
        status: 'proposed',
        accessAuthorizationId: expiredAuthorization.id,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        idempotencyKey: `expired-settlement-${crypto.randomUUID()}`,
      });

      await expect(
        new ReceivingBusinessSettlementService(db).inspectAuthorizedClaim({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          access: {
            settlementId: expiredSettlement.settlement.id,
            authorizationId: expiredAuthorization.id,
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_ACCESS_INVALID',
      });
    });

    it('explicitly accepts and reserves atomically, consumes access authority, snapshots fulfillment, and appends both events', async () => {
      const created = await createClaim();
      const proposal = await propose(
        created.customerId,
        created.claim.id,
        receivingBusinessId,
      );

      const service = new ReceivingBusinessSettlementService(db);
      const result = await service.acceptAndReserve({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: proposal.settlement.id,
        acceptance: {
          authorizationId: proposal.authorization.id,
          fulfillment,
        },
      });

      expect(result.changed).toBe(true);
      expect(result.claim.status).toBe('reserved');
      expect(result.settlement.status).toBe('reserved');
      expect(result.settlement.receivingBranchId).toBe(receivingBranchId);
      expect(result.settlement.acceptedByUserId).toBe(actorUserId);
      expect(result.settlement.acceptedAt).not.toBeNull();
      expect(result.settlement.fulfillmentPolicyVersion).toBe(
        ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
      );
      expect(result.settlement.fulfillmentSnapshot).toEqual({
        benefitType: 'voucher',
        title: fulfillment.title,
        description: fulfillment.description,
        terms: fulfillment.terms,
      });
      expect(result.settlement.fulfillmentReference).toBe(
        fulfillment.reference,
      );

      const authorization =
        await repos.customerActionAuthorizations.findById(
          proposal.authorization.id,
        );
      expect(authorization?.status).toBe('consumed');

      const events = await repos.orphanSettlementEvents.listForSettlement(
        proposal.settlement.id,
      );
      expect(
        events.filter((event) => event.eventType === 'partner_accepted'),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.eventType === 'settlement_reserved'),
      ).toHaveLength(1);

      const replay = await service.acceptAndReserve({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: proposal.settlement.id,
        acceptance: {
          authorizationId: proposal.authorization.id,
          fulfillment,
        },
      });
      expect(replay.changed).toBe(false);
      expect(replay.settlement.id).toBe(result.settlement.id);
      expect(replay.partnerAcceptedEvent.id).toBe(
        result.partnerAcceptedEvent.id,
      );
      expect(replay.settlementReservedEvent.id).toBe(
        result.settlementReservedEvent.id,
      );
    });

    it('binds a reservation to the trusted receiving branch and rejects a conflicting replay from another branch', async () => {
      const created = await createClaim();
      const proposal = await propose(
        created.customerId,
        created.claim.id,
        receivingBusinessId,
      );
      const service = new ReceivingBusinessSettlementService(db);

      await service.acceptAndReserve({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: proposal.settlement.id,
        acceptance: {
          authorizationId: proposal.authorization.id,
          fulfillment,
        },
      });

      await expect(
        service.acceptAndReserve({
          businessId: receivingBusinessId,
          branchId: otherReceivingBranchId,
          actorUserId,
          settlementId: proposal.settlement.id,
          acceptance: {
            authorizationId: proposal.authorization.id,
            fulfillment,
          },
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ORPHAN_SETTLEMENT_BRANCH_MISMATCH',
      });
    });

    it('allows only one competing business proposal to reserve the claim', async () => {
      const created = await createClaim();
      const first = await propose(
        created.customerId,
        created.claim.id,
        receivingBusinessId,
      );
      const second = await propose(
        created.customerId,
        created.claim.id,
        competingBusinessId,
      );

      await new ReceivingBusinessSettlementService(db).acceptAndReserve({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId,
        settlementId: first.settlement.id,
        acceptance: {
          authorizationId: first.authorization.id,
          fulfillment,
        },
      });

      await expect(
        new ReceivingBusinessSettlementService(db).acceptAndReserve({
          businessId: competingBusinessId,
          actorUserId,
          settlementId: second.settlement.id,
          acceptance: {
            authorizationId: second.authorization.id,
            fulfillment,
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_CLAIM_NOT_AVAILABLE',
      });

      expect(
        (await repos.orphanRewardClaims.findById(created.claim.id))?.status,
      ).toBe('reserved');
      expect(
        (await repos.orphanSettlements.findById(second.settlement.id))?.status,
      ).toBe('proposed');
    });

    it('rolls back authorization consumption and both projections when append-only acceptance history conflicts', async () => {
      const created = await createClaim();
      const proposal = await propose(
        created.customerId,
        created.claim.id,
        receivingBusinessId,
      );

      await repos.orphanSettlementEvents.appendIdempotent({
        claimId: created.claim.id,
        settlementId: proposal.settlement.id,
        customerId: created.customerId,
        eventType: 'partner_accepted',
        originBusinessId,
        receivingBusinessId: competingBusinessId,
        actorUserId,
        customerActionAuthorizationId: proposal.authorization.id,
        idempotencyKey: `partner-accepted:${proposal.settlement.id}`,
      });

      await expect(
        new ReceivingBusinessSettlementService(db).acceptAndReserve({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId,
          settlementId: proposal.settlement.id,
          acceptance: {
            authorizationId: proposal.authorization.id,
            fulfillment,
          },
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_EVENT_CONFLICT',
      });

      expect(
        (await repos.orphanRewardClaims.findById(created.claim.id))?.status,
      ).toBe('available');
      expect(
        (await repos.orphanSettlements.findById(proposal.settlement.id))?.status,
      ).toBe('proposed');
      expect(
        (
          await repos.customerActionAuthorizations.findById(
            proposal.authorization.id,
          )
        )?.status,
      ).toBe('active');
    });

    it('does not mutate either business loyalty or Community Point ledgers during acceptance', async () => {
      const created = await createClaim();
      const proposal = await propose(
        created.customerId,
        created.claim.id,
        receivingBusinessId,
      );

      const loyaltyBefore = await repos.loyaltyTransactions.listForAccount(
        created.account.id,
      );
      const communityAccount =
        await repos.communityPointAccounts.findByCustomerId(
          created.customerId,
        );
      const communityBefore = communityAccount
        ? await repos.communityPointTransactions.listForAccount(
            communityAccount.id,
          )
        : [];

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

      expect(
        await repos.loyaltyTransactions.listForAccount(created.account.id),
      ).toEqual(loyaltyBefore);

      const communityAfter =
        await repos.communityPointAccounts.findByCustomerId(
          created.customerId,
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
