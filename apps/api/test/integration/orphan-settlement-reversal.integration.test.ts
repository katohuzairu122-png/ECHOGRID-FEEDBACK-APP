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
import { OrphanSettlementReversalService } from '../../src/orphan-settlement/orphan-settlement-reversal.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 fulfilled settlement reversal and evidence invalidation (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let originBusinessId: string;
    let receivingBusinessId: string;
    let receivingBranchId: string;
    let managerUserId: string;
    let adminUserId: string;
    let supportUserId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      originBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Reversal Origin',
          slug: `split06-reversal-origin-${suffix}`,
          status: 'archived',
        })
      ).id;

      receivingBusinessId = (
        await repos.businesses.create({
          name: 'Split 06 Reversal Receiver',
          slug: `split06-reversal-receiver-${suffix}`,
          status: 'active',
        })
      ).id;

      receivingBranchId = (
        await repos.branches.create({
          businessId: receivingBusinessId,
          name: 'Reversal Branch',
          slug: `split06-reversal-branch-${suffix}`,
        })
      ).id;

      managerUserId = (
        await repos.users.create({
          email: `split06-reversal-manager-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Reversal Manager',
          status: 'active',
        })
      ).id;

      adminUserId = (
        await repos.users.create({
          email: `split06-reversal-admin-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Reversal Admin',
          status: 'active',
          platformRole: 'admin',
        })
      ).id;

      supportUserId = (
        await repos.users.create({
          email: `split06-reversal-support-${suffix}@example.test`,
          passwordHash: 'not-used-in-integration',
          fullName: 'Split 06 Reversal Support',
          status: 'active',
          platformRole: 'support',
        })
      ).id;
    });

    afterAll(async () => {
      await client.end();
    });

    async function createFulfilledSettlement() {
      const customer = await repos.customers.create({
        phone: `+1592${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });

      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-reversal-test',
      });

      const account = await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 120,
      });

      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Reversal voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '35.00',
        description: 'Historical orphanable reversal voucher',
        status: 'active',
      });

      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -35,
        relatedRewardId: reward.id,
        redemptionCode: `S06V-${crypto.randomUUID()}`,
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
          correlationId: `reversal-access-${crypto.randomUUID()}`,
          idempotencyKey: `reversal-proposal-${crypto.randomUUID()}`,
        },
      );

      const fulfillment = {
        benefitType: 'voucher' as const,
        title: 'Reversal replacement voucher',
        description: 'One replacement voucher for this orphan settlement.',
        terms: 'Valid once at the accepting branch.',
        reference: `reversal-offer-${crypto.randomUUID()}`,
      };

      const accepted =
        await new ReceivingBusinessSettlementService(db).acceptAndReserve({
          businessId: receivingBusinessId,
          branchId: receivingBranchId,
          actorUserId: managerUserId,
          settlementId: proposal.settlement.id,
          acceptance: {
            authorizationId: proposal.authorization.id,
            fulfillment,
          },
        });

      const completion =
        await new CustomerSettlementCompletionService(db).authorizeCompletion(
          customer.id,
          accepted.settlement.id,
          {
            correlationId: `reversal-completion-${crypto.randomUUID()}`,
            idempotencyKey: `reversal-completion-${crypto.randomUUID()}`,
            fulfillmentPolicyVersion:
              ORPHAN_SETTLEMENT_FULFILLMENT_POLICY_VERSION,
            fulfillmentReference: fulfillment.reference,
          },
        );

      const fulfilled = await new OrphanSettlementFulfillmentService(db).fulfill({
        businessId: receivingBusinessId,
        branchId: receivingBranchId,
        actorUserId: managerUserId,
        settlementId: accepted.settlement.id,
      });

      return {
        customerId: customer.id,
        account,
        claim: fulfilled.claim,
        settlement: fulfilled.settlement,
        completion,
        fulfilled,
      };
    }

    function reversalInput() {
      return {
        reasonCode: 'verified_fulfillment_invalidated',
        evidenceReference: `case-${crypto.randomUUID()}`,
        idempotencyKey: `reversal-${crypto.randomUUID()}`,
        note: 'Verified platform reversal evidence.',
      };
    }

    it('requires active platform-admin authority even when service is called directly', async () => {
      const fixture = await createFulfilledSettlement();

      await expect(
        new OrphanSettlementReversalService(db).reverse(
          fixture.settlement.id,
          reversalInput(),
          { actorUserId: supportUserId },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ORPHAN_SETTLEMENT_REVERSAL_AUTHORITY_REQUIRED',
      });

      expect(
        (await repos.orphanSettlements.findById(fixture.settlement.id))?.status,
      ).toBe('fulfilled');
      expect(
        (await repos.orphanRewardClaims.findById(fixture.claim.id))?.status,
      ).toBe('settled');
    });

    it('reverses only fulfilled settlement/settled claim, preserves fulfilled history, writes semantic audit, and emits deterministic reversal evidence', async () => {
      const fixture = await createFulfilledSettlement();
      const input = reversalInput();
      const service = new OrphanSettlementReversalService(db);

      const result = await service.reverse(
        fixture.settlement.id,
        input,
        {
          actorUserId: adminUserId,
          ipAddress: '127.0.0.1',
          userAgent: 'split06-reversal-test',
        },
      );

      expect(result.changed).toBe(true);
      expect(result.settlement.status).toBe('reversed');
      expect(result.claim.status).toBe('reversed');
      expect(result.claim.reversedAt).not.toBeNull();

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.settlement.id,
      );
      expect(
        events.filter((event) => event.eventType === 'settlement_fulfilled'),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.eventType === 'settlement_reversed'),
      ).toHaveLength(1);

      expect(result.evidence).toEqual({
        evidenceVersion: 'v1',
        settlementRef: fixture.settlement.id,
        claimId: fixture.claim.id,
        customerId: fixture.customerId,
        originBusinessId,
        receivingBusinessId,
        receivingBranchId,
        originalFulfilledAt: fixture.settlement.fulfilledAt?.toISOString(),
        reversedAt: result.claim.reversedAt?.toISOString(),
        reversalRef: result.reversalEvent.id,
        reasonCode: input.reasonCode,
        evidenceReference: input.evidenceReference,
      });

      const auditRows = await repos.auditLog.listForEntity(
        'orphan_settlement',
        fixture.settlement.id,
      );
      const reversalAudit = auditRows.find(
        (row) => row.action === 'orphan_settlement.reversed',
      );
      expect(reversalAudit).toBeDefined();
      expect(reversalAudit?.actorUserId).toBe(adminUserId);
      expect(reversalAudit?.businessId).toBe(receivingBusinessId);

      expect(
        await service.getReversalEvidence(fixture.settlement.id),
      ).toEqual(result.evidence);
    });

    it('invalidates completion evidence after reversal while leaving reversal evidence resolvable', async () => {
      const fixture = await createFulfilledSettlement();
      const fulfillmentService = new OrphanSettlementFulfillmentService(db);
      const reversalService = new OrphanSettlementReversalService(db);

      const before = await fulfillmentService.getCompletionEvidence(
        fixture.settlement.id,
      );
      expect(before.settlementRef).toBe(fixture.settlement.id);

      const reversed = await reversalService.reverse(
        fixture.settlement.id,
        reversalInput(),
        { actorUserId: adminUserId },
      );

      await expect(
        fulfillmentService.getCompletionEvidence(fixture.settlement.id),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_COMPLETION_EVIDENCE_INVALIDATED',
      });

      expect(
        await reversalService.getReversalEvidence(fixture.settlement.id),
      ).toEqual(reversed.evidence);
    });

    it('is exact-replay safe and rejects a different reversal key/evidence after reversal', async () => {
      const fixture = await createFulfilledSettlement();
      const service = new OrphanSettlementReversalService(db);
      const input = reversalInput();

      const first = await service.reverse(
        fixture.settlement.id,
        input,
        { actorUserId: adminUserId },
      );
      const replay = await service.reverse(
        fixture.settlement.id,
        input,
        { actorUserId: adminUserId },
      );

      expect(replay.changed).toBe(false);
      expect(replay.reversalEvent.id).toBe(first.reversalEvent.id);
      expect(replay.evidence).toEqual(first.evidence);

      await expect(
        service.reverse(
          fixture.settlement.id,
          reversalInput(),
          { actorUserId: adminUserId },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_REVERSAL_CONFLICT',
      });

      const events = await repos.orphanSettlementEvents.listForSettlement(
        fixture.settlement.id,
      );
      expect(
        events.filter((event) => event.eventType === 'settlement_reversed'),
      ).toHaveLength(1);
    });

    it('rejects reversal before fulfillment', async () => {
      const customer = await repos.customers.create({
        phone: `+1591${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      const membership = await repos.customerMemberships.create({
        customerId: customer.id,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-reversal-pre-fulfillment',
      });
      const account = await repos.loyaltyAccounts.create({
        customerId: customer.id,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 40,
      });
      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Pre-fulfillment voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '10.00',
        status: 'active',
      });
      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -10,
        relatedRewardId: reward.id,
        redemptionCode: `S06PRE-${crypto.randomUUID()}`,
        issuanceStatus: 'issued',
      });
      const claim = await new OrphanQualificationService(db).qualify({
        sourceTransactionId: source.id,
        customerId: customer.id,
        originBusinessId,
        orphanReason: 'origin_business_archived',
      });
      const proposal = await new CustomerOrphanAccessService(db).authorizeAccess(
        customer.id,
        claim.claim.id,
        {
          receivingBusinessId,
          consentVersion: 'settlement-v1',
          correlationId: `pre-reversal-${crypto.randomUUID()}`,
          idempotencyKey: `pre-reversal-${crypto.randomUUID()}`,
        },
      );

      await expect(
        new OrphanSettlementReversalService(db).reverse(
          proposal.settlement.id,
          reversalInput(),
          { actorUserId: adminUserId },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_REVERSAL_NOT_ALLOWED',
      });
    });

    it('rolls back settlement/claim reversal when authoritative reversal history conflicts', async () => {
      const fixture = await createFulfilledSettlement();
      const input = reversalInput();

      await repos.orphanSettlementEvents.appendIdempotent({
        claimId: fixture.claim.id,
        settlementId: fixture.settlement.id,
        customerId: fixture.customerId,
        eventType: 'settlement_reversed',
        originBusinessId,
        receivingBusinessId,
        receivingBranchId,
        actorUserId: adminUserId,
        customerActionAuthorizationId:
          fixture.settlement.completionAuthorizationId,
        idempotencyKey: `settlement-reversed:${input.idempotencyKey}`,
        metadata: {
          reasonCode: 'different_reason',
          evidenceReference: 'different-case',
        },
      });

      await expect(
        new OrphanSettlementReversalService(db).reverse(
          fixture.settlement.id,
          input,
          { actorUserId: adminUserId },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SETTLEMENT_REVERSAL_CONFLICT',
      });

      expect(
        (await repos.orphanSettlements.findById(fixture.settlement.id))?.status,
      ).toBe('fulfilled');
      expect(
        (await repos.orphanRewardClaims.findById(fixture.claim.id))?.status,
      ).toBe('settled');
    });

    it('does not mutate origin/receiving loyalty or Community Point ledgers during reversal', async () => {
      const fixture = await createFulfilledSettlement();
      const originBefore = await repos.loyaltyTransactions.listForAccount(
        fixture.account.id,
      );
      const receivingBefore =
        await repos.loyaltyAccounts.findByCustomerAndBusiness(
          fixture.customerId,
          receivingBusinessId,
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

      await new OrphanSettlementReversalService(db).reverse(
        fixture.settlement.id,
        reversalInput(),
        { actorUserId: adminUserId },
      );

      expect(
        await repos.loyaltyTransactions.listForAccount(fixture.account.id),
      ).toEqual(originBefore);
      expect(
        await repos.loyaltyAccounts.findByCustomerAndBusiness(
          fixture.customerId,
          receivingBusinessId,
        ),
      ).toEqual(receivingBefore);

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
