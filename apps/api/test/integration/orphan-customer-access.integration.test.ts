import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { OrphanQualificationService } from '../../src/orphan-settlement/orphan-qualification.service';
import { CustomerOrphanAccessService } from '../../src/orphan-settlement/customer-orphan-access.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 customer orphan access (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let customerId: string;
    let otherCustomerId: string;
    let originBusinessId: string;
    let receivingBusinessId: string;
    let otherReceivingBusinessId: string;
    let suspendedBusinessId: string;
    let claimId: string;
    let otherClaimId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const customer = await repos.customers.create({
        phone: `+1595${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const otherCustomer = await repos.customers.create({
        phone: `+1596${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      otherCustomerId = otherCustomer.id;

      const origin = await repos.businesses.create({
        name: 'Split 06 Access Origin',
        slug: `split06-access-origin-${suffix}`,
        status: 'archived',
      });
      originBusinessId = origin.id;

      const receiving = await repos.businesses.create({
        name: 'Split 06 Receiving Business',
        slug: `split06-access-receiving-${suffix}`,
        status: 'active',
      });
      receivingBusinessId = receiving.id;

      const otherReceiving = await repos.businesses.create({
        name: 'Split 06 Other Receiving',
        slug: `split06-access-other-${suffix}`,
        status: 'active',
      });
      otherReceivingBusinessId = otherReceiving.id;

      const suspended = await repos.businesses.create({
        name: 'Split 06 Suspended Receiving',
        slug: `split06-access-suspended-${suffix}`,
        status: 'suspended',
      });
      suspendedBusinessId = suspended.id;

      claimId = await createClaim(customerId);
      otherClaimId = await createClaim(otherCustomerId);
    });

    afterAll(async () => {
      await client.end();
    });

    async function createClaim(targetCustomerId: string): Promise<string> {
      const membership = await repos.customerMemberships.create({
        customerId: targetCustomerId,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-access-test',
      });
      const account = await repos.loyaltyAccounts.create({
        customerId: targetCustomerId,
        businessId: originBusinessId,
        membershipId: membership.id,
        points: 50,
      });
      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: `Access voucher ${crypto.randomUUID()}`,
        type: 'voucher',
        rewardValue: '10.00',
        status: 'active',
      });
      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId: account.id,
        type: 'redemption',
        points: -10,
        relatedRewardId: reward.id,
        redemptionCode: `S06A-${crypto.randomUUID()}`,
        issuanceStatus: 'issued',
      });

      const result = await new OrphanQualificationService(db).qualify({
        sourceTransactionId: source.id,
        customerId: targetCustomerId,
        originBusinessId,
        orphanReason: 'origin_business_archived',
      });
      return result.claim.id;
    }

    it('lists and reads only claims owned by the authenticated customer identity', async () => {
      const service = new CustomerOrphanAccessService(db);
      const rows = await service.listClaims(customerId);

      expect(rows.some((row) => row.id === claimId)).toBe(true);
      expect(rows.some((row) => row.id === otherClaimId)).toBe(false);

      expect((await service.getClaim(customerId, claimId)).id).toBe(claimId);
      await expect(
        service.getClaim(customerId, otherClaimId),
      ).rejects.toMatchObject({
        status: 404,
        code: 'ORPHAN_CLAIM_NOT_FOUND',
      });
    });

    it('atomically grants scoped consent, issues short-lived access authority, creates a proposal, and appends partner_selected', async () => {
      const service = new CustomerOrphanAccessService(db);
      const before = await repos.orphanSettlements.listForClaim(claimId);
      expect(before).toHaveLength(0);

      const startedAt = Date.now();
      const result = await service.authorizeAccess(customerId, claimId, {
        receivingBusinessId,
        consentVersion: 'settlement-v1',
        correlationId: `corr-${crypto.randomUUID()}`,
        idempotencyKey: `access-${crypto.randomUUID()}`,
      });

      expect(result.changed).toBe(true);
      expect(result.consent.customerId).toBe(customerId);
      expect(result.consent.businessId).toBe(receivingBusinessId);
      expect(result.consent.purpose).toBe('settlement_access');
      expect(result.consent.resourceType).toBe('orphan_reward_claim');
      expect(result.consent.resourceId).toBe(claimId);

      expect(result.authorization.actionType).toBe('access_orphan_settlement');
      expect(result.authorization.customerId).toBe(customerId);
      expect(result.authorization.businessId).toBe(receivingBusinessId);
      expect(result.authorization.resourceId).toBe(claimId);
      expect(result.authorization.status).toBe('active');
      expect(result.authorization.expiresAt.getTime()).toBeGreaterThan(startedAt);
      expect(result.authorization.expiresAt.getTime()).toBeLessThanOrEqual(
        startedAt + 5 * 60 * 1000 + 5_000,
      );

      expect(result.settlement.status).toBe('proposed');
      expect(result.settlement.claimId).toBe(claimId);
      expect(result.settlement.receivingBusinessId).toBe(receivingBusinessId);
      expect(result.settlement.accessAuthorizationId).toBe(result.authorization.id);

      expect(result.event.eventType).toBe('partner_selected');
      expect(result.event.settlementId).toBe(result.settlement.id);
      expect(result.event.customerActionAuthorizationId).toBe(
        result.authorization.id,
      );

      const claim = await repos.orphanRewardClaims.findById(claimId);
      expect(claim?.status).toBe('available');
    });

    it('replays the exact request without duplicating consent, authorization, proposal, or event', async () => {
      const service = new CustomerOrphanAccessService(db);
      const input = {
        receivingBusinessId: otherReceivingBusinessId,
        consentVersion: 'settlement-v1',
        correlationId: `corr-${crypto.randomUUID()}`,
        idempotencyKey: `access-replay-${crypto.randomUUID()}`,
      };

      const first = await service.authorizeAccess(customerId, claimId, input);
      const second = await service.authorizeAccess(customerId, claimId, input);

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.consent.id).toBe(first.consent.id);
      expect(second.authorization.id).toBe(first.authorization.id);
      expect(second.settlement.id).toBe(first.settlement.id);
      expect(second.event.id).toBe(first.event.id);
    });

    it('rejects material reuse of the same idempotency key for another business', async () => {
      const service = new CustomerOrphanAccessService(db);
      const key = `access-conflict-${crypto.randomUUID()}`;
      const correlationId = `corr-${crypto.randomUUID()}`;

      await service.authorizeAccess(customerId, claimId, {
        receivingBusinessId,
        consentVersion: 'settlement-v1',
        correlationId,
        idempotencyKey: key,
      });

      await expect(
        service.authorizeAccess(customerId, claimId, {
          receivingBusinessId: otherReceivingBusinessId,
          consentVersion: 'settlement-v1',
          correlationId,
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_ACCESS_IDEMPOTENCY_CONFLICT',
      });
    });

    it('rejects access for another customer, the origin business, and non-active receiving businesses', async () => {
      const service = new CustomerOrphanAccessService(db);
      const base = {
        consentVersion: 'settlement-v1',
        correlationId: `corr-${crypto.randomUUID()}`,
      };

      await expect(
        service.authorizeAccess(otherCustomerId, claimId, {
          ...base,
          receivingBusinessId,
          idempotencyKey: `wrong-owner-${crypto.randomUUID()}`,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'ORPHAN_CLAIM_NOT_FOUND',
      });

      await expect(
        service.authorizeAccess(customerId, claimId, {
          ...base,
          receivingBusinessId: originBusinessId,
          idempotencyKey: `origin-${crypto.randomUUID()}`,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_RECEIVING_BUSINESS_INVALID',
      });

      await expect(
        service.authorizeAccess(customerId, claimId, {
          ...base,
          receivingBusinessId: suspendedBusinessId,
          idempotencyKey: `suspended-${crypto.randomUUID()}`,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_RECEIVING_BUSINESS_INVALID',
      });
    });

    it('does not reserve the claim or mutate loyalty/Community ledgers when access is authorized', async () => {
      const claim = await repos.orphanRewardClaims.findById(claimId);
      expect(claim).toBeDefined();
      const loyaltyBefore = await repos.loyaltyTransactions.listForAccount(
        claim!.originLoyaltyAccountId,
      );
      const communityAccount = await repos.communityPointAccounts.findByCustomerId(
        customerId,
      );
      const communityBefore = communityAccount
        ? await repos.communityPointTransactions.listForAccount(communityAccount.id)
        : [];

      await new CustomerOrphanAccessService(db).authorizeAccess(customerId, claimId, {
        receivingBusinessId,
        consentVersion: 'settlement-v1',
        correlationId: `corr-${crypto.randomUUID()}`,
        idempotencyKey: `isolation-${crypto.randomUUID()}`,
      });

      expect((await repos.orphanRewardClaims.findById(claimId))?.status).toBe(
        'available',
      );
      expect(
        await repos.loyaltyTransactions.listForAccount(
          claim!.originLoyaltyAccountId,
        ),
      ).toEqual(loyaltyBefore);

      const communityAfter = await repos.communityPointAccounts.findByCustomerId(
        customerId,
      );
      expect(communityAfter).toEqual(communityAccount);
      if (communityAfter) {
        expect(
          await repos.communityPointTransactions.listForAccount(communityAfter.id),
        ).toEqual(communityBefore);
      }
    });
  },
);
