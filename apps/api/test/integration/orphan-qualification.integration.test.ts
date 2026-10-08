import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { OrphanQualificationService } from '../../src/orphan-settlement/orphan-qualification.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 authoritative orphan qualification (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let customerId: string;
    let otherCustomerId: string;
    let archivedBusinessId: string;
    let otherBusinessId: string;
    let activeBusinessId: string;
    let archivedAccountId: string;
    let archivedMembershipId: string;
    let adminUserId: string;
    let ordinaryUserId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const customer = await repos.customers.create({
        phone: `+1593${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const otherCustomer = await repos.customers.create({
        phone: `+1594${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      otherCustomerId = otherCustomer.id;

      const archivedBusiness = await repos.businesses.create({
        name: 'Split 06 Archived Origin',
        slug: `split06-q-archived-${suffix}`,
        status: 'archived',
      });
      archivedBusinessId = archivedBusiness.id;

      const otherBusiness = await repos.businesses.create({
        name: 'Split 06 Other Business',
        slug: `split06-q-other-${suffix}`,
      });
      otherBusinessId = otherBusiness.id;

      const activeBusiness = await repos.businesses.create({
        name: 'Split 06 Active Origin',
        slug: `split06-q-active-${suffix}`,
        status: 'active',
      });
      activeBusinessId = activeBusiness.id;

      const membership = await repos.customerMemberships.create({
        customerId,
        businessId: archivedBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-qualification-test',
      });
      archivedMembershipId = membership.id;

      const account = await repos.loyaltyAccounts.create({
        customerId,
        businessId: archivedBusinessId,
        membershipId: membership.id,
        points: 100,
      });
      archivedAccountId = account.id;

      const admin = await repos.users.create({
        email: `split06-q-admin-${suffix}@example.test`,
        passwordHash: 'not-used-in-integration',
        fullName: 'Split 06 Platform Admin',
        status: 'active',
        emailVerifiedAt: new Date(),
        platformRole: 'admin',
      });
      adminUserId = admin.id;

      const ordinary = await repos.users.create({
        email: `split06-q-user-${suffix}@example.test`,
        passwordHash: 'not-used-in-integration',
        fullName: 'Split 06 Ordinary User',
        status: 'active',
        emailVerifiedAt: new Date(),
      });
      ordinaryUserId = ordinary.id;
    });

    afterAll(async () => {
      await client.end();
    });

    async function issuedEntitlement(options: {
      businessId?: string;
      customer?: string;
      accountId?: string;
      rewardType?: 'discount' | 'free_item' | 'voucher' | 'points';
      rewardStatus?: 'active' | 'inactive' | 'paused';
      expiryDate?: Date;
      issuanceStatus?: 'issued' | 'redeemed' | 'expired' | 'reversed';
      confirmed?: boolean;
    } = {}) {
      const businessId = options.businessId ?? archivedBusinessId;
      const targetCustomerId = options.customer ?? customerId;
      let accountId = options.accountId;

      if (!accountId) {
        if (businessId === archivedBusinessId && targetCustomerId === customerId) {
          accountId = archivedAccountId;
        } else {
          const membership = await repos.customerMemberships.create({
            customerId: targetCustomerId,
            businessId,
            status: businessId === archivedBusinessId ? 'business_exited' : 'active',
            onboardingSource: 'split06-qualification-helper',
          });
          const account = await repos.loyaltyAccounts.create({
            customerId: targetCustomerId,
            businessId,
            membershipId: membership.id,
            points: 100,
          });
          accountId = account.id;
        }
      }

      const rewardType = options.rewardType ?? 'voucher';
      const reward = await repos.loyaltyRewards.create({
        businessId,
        name: `Qualification ${rewardType} ${crypto.randomUUID()}`,
        type: rewardType,
        ...(rewardType === 'points'
          ? { pointsCost: 10 }
          : { rewardValue: rewardType === 'free_item' ? null : '10.00' }),
        status: options.rewardStatus ?? 'active',
        ...(options.expiryDate ? { expiryDate: options.expiryDate } : {}),
      });

      const transaction = await repos.loyaltyTransactions.create({
        loyaltyAccountId: accountId,
        type: 'redemption',
        points: -10,
        relatedRewardId: reward.id,
        redemptionCode: `S06Q-${crypto.randomUUID()}`,
        issuanceStatus: options.issuanceStatus ?? 'issued',
        ...(options.confirmed ? { redemptionConfirmedAt: new Date() } : {}),
      });

      return { reward, transaction, accountId };
    }

    it('qualifies an outstanding issued non-points entitlement exactly once and appends orphan_created atomically', async () => {
      const { transaction } = await issuedEntitlement();
      const service = new OrphanQualificationService(db);
      const input = {
        sourceTransactionId: transaction.id,
        customerId,
        originBusinessId: archivedBusinessId,
        orphanReason: 'origin_business_archived' as const,
      };

      const first = await service.qualify(input);
      const replay = await service.qualify(input);

      expect(first.changed).toBe(true);
      expect(first.claim.originLoyaltyTransactionId).toBe(transaction.id);
      expect(first.claim.originMembershipId).toBe(archivedMembershipId);
      expect(first.claim.status).toBe('available');
      expect(first.event.eventType).toBe('orphan_created');

      expect(replay.changed).toBe(false);
      expect(replay.claim.id).toBe(first.claim.id);
      expect(replay.event.id).toBe(first.event.id);

      const events = await repos.orphanSettlementEvents.listForClaim(first.claim.id);
      expect(events.filter((event) => event.eventType === 'orphan_created')).toHaveLength(1);

      const sourceAfter = await repos.loyaltyTransactions.findById(transaction.id);
      expect(sourceAfter).toEqual(transaction);
    });

    it('does not let inactive catalog state erase an already-issued entitlement', async () => {
      const { transaction } = await issuedEntitlement({ rewardStatus: 'inactive' });

      const result = await new OrphanQualificationService(db).qualify({
        sourceTransactionId: transaction.id,
        customerId,
        originBusinessId: archivedBusinessId,
        orphanReason: 'origin_business_archived',
      });

      expect(result.claim.sourceRewardType).toBe('voucher');
      expect(result.claim.status).toBe('available');
    });

    it('rejects nonexistent, redeemed, confirmed, expired and points-only source entitlements', async () => {
      const service = new OrphanQualificationService(db);

      await expect(
        service.qualify({
          sourceTransactionId: crypto.randomUUID(),
          customerId,
          originBusinessId: archivedBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'ORPHAN_SOURCE_NOT_FOUND',
      });

      for (const options of [
        { issuanceStatus: 'redeemed' as const },
        { confirmed: true },
      ]) {
        const { transaction } = await issuedEntitlement(options);
        await expect(
          service.qualify({
            sourceTransactionId: transaction.id,
            customerId,
            originBusinessId: archivedBusinessId,
            orphanReason: 'origin_business_archived',
          }),
        ).rejects.toMatchObject({
          status: 409,
          code: 'ORPHAN_SOURCE_NOT_OUTSTANDING',
        });
      }

      const expired = await issuedEntitlement({
        expiryDate: new Date(Date.now() - 60_000),
      });
      await expect(
        service.qualify({
          sourceTransactionId: expired.transaction.id,
          customerId,
          originBusinessId: archivedBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SOURCE_REWARD_EXPIRED',
      });

      const points = await issuedEntitlement({ rewardType: 'points' });
      await expect(
        service.qualify({
          sourceTransactionId: points.transaction.id,
          customerId,
          originBusinessId: archivedBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SOURCE_REWARD_TYPE_INVALID',
      });
      expect(
        await repos.orphanRewardClaims.findBySourceTransaction(
          points.transaction.id,
        ),
      ).toBeUndefined();
    });

    it('rejects asserted customer/business mappings that do not own the source', async () => {
      const { transaction } = await issuedEntitlement();
      const service = new OrphanQualificationService(db);

      await expect(
        service.qualify({
          sourceTransactionId: transaction.id,
          customerId: otherCustomerId,
          originBusinessId: archivedBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SOURCE_MAPPING_MISMATCH',
      });

      await expect(
        service.qualify({
          sourceTransactionId: transaction.id,
          customerId,
          originBusinessId: otherBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_SOURCE_MAPPING_MISMATCH',
      });
    });

    it('requires the archived condition instead of inferring orphaning from unrelated business state', async () => {
      const { transaction } = await issuedEntitlement({
        businessId: activeBusinessId,
      });

      await expect(
        new OrphanQualificationService(db).qualify({
          sourceTransactionId: transaction.id,
          customerId,
          originBusinessId: activeBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_CONDITION_NOT_MET',
      });

      expect(
        await repos.orphanRewardClaims.findBySourceTransaction(
          transaction.id,
        ),
      ).toBeUndefined();
    });

    it('permits explicit platform inability-to-honor only from an active platform admin', async () => {
      const denied = await issuedEntitlement({
        businessId: activeBusinessId,
      });
      const service = new OrphanQualificationService(db);

      await expect(
        service.qualify({
          sourceTransactionId: denied.transaction.id,
          customerId,
          originBusinessId: activeBusinessId,
          orphanReason: 'platform_unable_to_honor',
          actorUserId: ordinaryUserId,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'ORPHAN_PLATFORM_AUTHORITY_REQUIRED',
      });

      const allowed = await issuedEntitlement({
        businessId: activeBusinessId,
      });
      const result = await service.qualify({
        sourceTransactionId: allowed.transaction.id,
        customerId,
        originBusinessId: activeBusinessId,
        orphanReason: 'platform_unable_to_honor',
        actorUserId: adminUserId,
      });

      expect(result.claim.orphanReason).toBe('platform_unable_to_honor');
      expect(result.event.actorUserId).toBe(adminUserId);
    });

    it('rolls back claim creation when the authoritative orphan_created event conflicts', async () => {
      const target = await issuedEntitlement();
      const other = await issuedEntitlement();

      const otherClaim = await repos.orphanRewardClaims.createIdempotent({
        customerId,
        originBusinessId: archivedBusinessId,
        originMembershipId: archivedMembershipId,
        originLoyaltyAccountId: archivedAccountId,
        originLoyaltyTransactionId: other.transaction.id,
        originRewardId: other.reward.id,
        orphanReason: 'origin_business_archived',
        status: 'available',
        sourceRewardType: 'voucher',
        sourceRewardSnapshot: { seeded: true },
      });

      await repos.orphanSettlementEvents.appendIdempotent({
        claimId: otherClaim.claim.id,
        customerId,
        eventType: 'orphan_created',
        originBusinessId: archivedBusinessId,
        idempotencyKey: `orphan-created:${target.transaction.id}`,
      });

      await expect(
        new OrphanQualificationService(db).qualify({
          sourceTransactionId: target.transaction.id,
          customerId,
          originBusinessId: archivedBusinessId,
          orphanReason: 'origin_business_archived',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'ORPHAN_EVENT_IDEMPOTENCY_CONFLICT',
      });

      expect(
        await repos.orphanRewardClaims.findBySourceTransaction(
          target.transaction.id,
        ),
      ).toBeUndefined();
    });

    it('does not mutate business loyalty or Community Point ledgers during qualification', async () => {
      const { transaction, accountId } = await issuedEntitlement();
      const beforeLoyalty = await repos.loyaltyTransactions.listForAccount(accountId);
      const beforeCommunityAccounts =
        await repos.communityPointAccounts.findByCustomerId(customerId);
      const beforeCommunityTransactions = beforeCommunityAccounts
        ? await repos.communityPointTransactions.listForAccount(
            beforeCommunityAccounts.id,
          )
        : [];

      await new OrphanQualificationService(db).qualify({
        sourceTransactionId: transaction.id,
        customerId,
        originBusinessId: archivedBusinessId,
        orphanReason: 'origin_business_archived',
      });

      const afterLoyalty = await repos.loyaltyTransactions.listForAccount(accountId);
      expect(afterLoyalty).toEqual(beforeLoyalty);

      const afterCommunityAccounts =
        await repos.communityPointAccounts.findByCustomerId(customerId);
      expect(afterCommunityAccounts).toEqual(beforeCommunityAccounts);
      if (afterCommunityAccounts) {
        expect(
          await repos.communityPointTransactions.listForAccount(
            afterCommunityAccounts.id,
          ),
        ).toEqual(beforeCommunityTransactions);
      }
    });
  },
);
