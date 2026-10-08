import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import {
  orphanRewardClaims,
  orphanSettlementEvents,
  orphanSettlements,
} from '../../src/db/schema';
import { createRepositories } from '../../src/repositories';

async function expectPgCode(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error ${expectedCode}.`);
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; code?: string }).cause;
    const direct = (error as { code?: string }).code;
    expect(cause?.code ?? direct).toBe(expectedCode);
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 settlement foundations (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let repos: ReturnType<typeof createRepositories>;
    let customerId: string;
    let originBusinessId: string;
    let receivingBusinessId: string;
    let membershipId: string;
    let loyaltyAccountId: string;
    let sourceTransactionId: string;
    let rewardId: string;
    let actorUserId: string;
    let accessAuthorizationId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);
      repos = createRepositories(db);
      const suffix = crypto.randomUUID();

      const customer = await repos.customers.create({
        phone: `+1592${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
        phoneVerifiedAt: new Date(),
      });
      customerId = customer.id;

      const origin = await repos.businesses.create({
        name: 'Split 06 Origin Business',
        slug: `split06-origin-${suffix}`,
        status: 'archived',
      });
      originBusinessId = origin.id;

      const receiving = await repos.businesses.create({
        name: 'Split 06 Receiving Business',
        slug: `split06-receiving-${suffix}`,
      });
      receivingBusinessId = receiving.id;

      const membership = await repos.customerMemberships.create({
        customerId,
        businessId: originBusinessId,
        status: 'business_exited',
        onboardingSource: 'split06-foundation-test',
      });
      membershipId = membership.id;

      const account = await repos.loyaltyAccounts.create({
        customerId,
        businessId: originBusinessId,
        membershipId,
        points: 100,
      });
      loyaltyAccountId = account.id;

      const reward = await repos.loyaltyRewards.create({
        businessId: originBusinessId,
        name: 'Outstanding voucher',
        type: 'voucher',
        rewardValue: '10.00',
        status: 'active',
      });
      rewardId = reward.id;

      const source = await repos.loyaltyTransactions.create({
        loyaltyAccountId,
        type: 'redemption',
        points: -10,
        relatedRewardId: rewardId,
        redemptionCode: `S06-${suffix}`,
        issuanceStatus: 'issued',
      });
      sourceTransactionId = source.id;

      const actor = await repos.users.create({
        email: `split06-${suffix}@example.test`,
        passwordHash: 'not-used-in-integration',
        fullName: 'Split 06 Receiving Staff',
        status: 'active',
        emailVerifiedAt: new Date(),
      });
      actorUserId = actor.id;

      const access = await repos.customerActionAuthorizations.create({
        customerId,
        businessId: receivingBusinessId,
        actionType: 'access_orphan_settlement',
        resourceType: 'orphan_reward_claim',
        resourceId: sourceTransactionId,
        scope: 'settlement_access',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        correlationId: crypto.randomUUID(),
        idempotencyKey: `split06-access-${suffix}`,
      });
      accessAuthorizationId = access.id;
    });

    afterAll(async () => {
      await client.end();
    });

    it('creates one idempotent orphan claim per source entitlement', async () => {
      const input = {
        customerId,
        originBusinessId,
        originMembershipId: membershipId,
        originLoyaltyAccountId: loyaltyAccountId,
        originLoyaltyTransactionId: sourceTransactionId,
        originRewardId: rewardId,
        orphanReason: 'origin_business_archived' as const,
        status: 'available' as const,
        sourceRewardType: 'voucher' as const,
        sourceRewardSnapshot: {
          rewardName: 'Outstanding voucher',
          rewardType: 'voucher',
        },
      };

      const first = await repos.orphanRewardClaims.createIdempotent(input);
      const replay = await repos.orphanRewardClaims.createIdempotent(input);

      expect(first.inserted).toBe(true);
      expect(replay.inserted).toBe(false);
      expect(replay.claim.id).toBe(first.claim.id);
      expect(
        (
          await repos.orphanRewardClaims.findBySourceTransaction(
            sourceTransactionId,
          )
        )?.id,
      ).toBe(first.claim.id);
    });

    it('enforces frozen claim status and source reward vocabularies at PostgreSQL', async () => {
      await expectPgCode(
        db.insert(orphanRewardClaims).values({
          customerId,
          originBusinessId,
          originMembershipId: membershipId,
          originLoyaltyAccountId: loyaltyAccountId,
          originLoyaltyTransactionId: crypto.randomUUID(),
          originRewardId: rewardId,
          orphanReason: 'origin_business_archived',
          status: 'not-a-real-status' as never,
          sourceRewardType: 'voucher',
          sourceRewardSnapshot: {},
        }),
        '23514',
      );
    });

    it('keeps settlement creation idempotent and permits only one active reservation per claim', async () => {
      const claim = await repos.orphanRewardClaims.findBySourceTransaction(
        sourceTransactionId,
      );
      expect(claim).toBeDefined();

      const key = `split06-settlement-${crypto.randomUUID()}`;
      const acceptedAt = new Date();
      const input = {
        claimId: claim!.id,
        customerId,
        receivingBusinessId,
        status: 'accepted' as const,
        accessAuthorizationId,
        acceptedByUserId: actorUserId,
        acceptedAt,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        idempotencyKey: key,
      };

      const first = await repos.orphanSettlements.createIdempotent(input);
      const replay = await repos.orphanSettlements.createIdempotent(input);
      expect(first.inserted).toBe(true);
      expect(replay.inserted).toBe(false);
      expect(replay.settlement.id).toBe(first.settlement.id);

      const secondAccess = await repos.customerActionAuthorizations.create({
        customerId,
        businessId: receivingBusinessId,
        actionType: 'access_orphan_settlement',
        resourceType: 'orphan_reward_claim',
        resourceId: claim!.id,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        correlationId: crypto.randomUUID(),
        idempotencyKey: `split06-second-access-${crypto.randomUUID()}`,
      });

      await expectPgCode(
        db.insert(orphanSettlements).values({
          claimId: claim!.id,
          customerId,
          receivingBusinessId,
          status: 'reserved',
          accessAuthorizationId: secondAccess.id,
          acceptedByUserId: actorUserId,
          acceptedAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60_000),
          idempotencyKey: `split06-competing-${crypto.randomUUID()}`,
        }),
        '23505',
      );
    });

    it('appends settlement events idempotently and requires settlement context after orphan creation', async () => {
      const claim = await repos.orphanRewardClaims.findBySourceTransaction(
        sourceTransactionId,
      );
      expect(claim).toBeDefined();

      const key = `split06-event-${crypto.randomUUID()}`;
      const first = await repos.orphanSettlementEvents.appendIdempotent({
        claimId: claim!.id,
        customerId,
        eventType: 'orphan_created',
        originBusinessId,
        idempotencyKey: key,
        metadata: { test: true },
      });
      const replay = await repos.orphanSettlementEvents.appendIdempotent({
        claimId: claim!.id,
        customerId,
        eventType: 'orphan_created',
        originBusinessId,
        idempotencyKey: key,
        metadata: { test: true },
      });

      expect(first.inserted).toBe(true);
      expect(replay.inserted).toBe(false);
      expect(replay.event.id).toBe(first.event.id);

      await expectPgCode(
        db.insert(orphanSettlementEvents).values({
          claimId: claim!.id,
          customerId,
          eventType: 'partner_selected',
          originBusinessId,
          receivingBusinessId,
          idempotencyKey: `split06-invalid-event-${crypto.randomUUID()}`,
        }),
        '23514',
      );

      const history = await repos.orphanSettlementEvents.listForClaim(claim!.id);
      expect(history.some((row) => row.id === first.event.id)).toBe(true);
      expect(
        (repos.orphanSettlementEvents as unknown as Record<string, unknown>).update,
      ).toBeUndefined();
      expect(
        (repos.orphanSettlementEvents as unknown as Record<string, unknown>).delete,
      ).toBeUndefined();
    });
  },
);
