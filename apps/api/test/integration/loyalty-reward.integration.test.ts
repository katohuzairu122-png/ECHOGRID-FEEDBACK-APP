import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyRewardService } from '../../src/loyalty/loyalty-reward.service';

// createdBy/updatedBy are `uuid` columns -- same reasoning as
// loyalty-redemption.integration.test.ts's STAFF_ACTOR_ID: a placeholder
// string fails at the database, not just in spirit.
const STAFF_ACTOR_ID = crypto.randomUUID();

/**
 * First integration coverage for LoyaltyRewardService (Continuing
 * Development Block 6.6, S6.1's "config-API gap" fix). Unlike
 * LoyaltyAccountService/LoyaltyRedemptionService -- integration-tested
 * first because they own their own transactions -- LoyaltyRewardService is
 * a plain create/update/list/remove wrapper, so its logic is already
 * covered against a fake repository in loyalty-reward.service.test.ts.
 * What that fake can't prove is whether Drizzle's real `.set()` actually
 * skips `undefined`-valued keys the way LoyaltyRewardService.update()
 * assumes (see convertCampaignFields' comment in loyalty-reward.service.ts)
 * -- that assumption is only meaningful against the real repository, and
 * this file is the only place it gets checked against real Postgres.
 *
 * Note for whoever runs this: `pnpm test:integration` needs a real
 * DATABASE_URL and is NOT part of CI (apps/api's CI job deliberately runs
 * the fake-repository unit tier only -- see .github/workflows/ci-cd.yml's
 * own comment). This suite skips cleanly without one; it has not been
 * executed in the sandbox this was written in, which has neither a
 * reachable database nor installed dependencies. Run it for real locally
 * before treating this coverage as proven, not just written.
 */
describe.skipIf(!process.env.DATABASE_URL)('LoyaltyRewardService (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let service: LoyaltyRewardService;
  let businessA: string;
  let businessB: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    service = new LoyaltyRewardService(repos);

    const bizA = await repos.businesses.create({
      name: 'Loyalty Reward Test Business A',
      slug: `loyalty-reward-a-${crypto.randomUUID()}`,
    });
    businessA = bizA.id;
    const bizB = await repos.businesses.create({
      name: 'Loyalty Reward Test Business B',
      slug: `loyalty-reward-b-${crypto.randomUUID()}`,
    });
    businessB = bizB.id;
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessA, businessA);
    await repos.businesses.softDelete(businessB, businessB);
    await client.end();
  });

  it('create() persists campaign fields to Postgres, round-tripping rewardValue/maxBudget as decimal strings and startDate/expiryDate as real timestamps', async () => {
    const created = await service.create(
      businessA,
      {
        name: 'Weekend discount',
        type: 'discount',
        rewardValue: 12.5,
        maxBudget: 1000,
        startDate: '2026-09-01T00:00:00.000Z',
        expiryDate: '2026-09-30T00:00:00.000Z',
        limitPer: 'visit',
        cooldownSeconds: 30,
      },
      STAFF_ACTOR_ID,
    );

    // Re-fetched independently rather than trusting create()'s own return
    // value, so this actually proves the row landed correctly in Postgres,
    // not just that the INSERT...RETURNING payload looked right in memory.
    const persisted = await repos.loyaltyRewards.findById(created.id, businessA);

    expect(persisted).toMatchObject({
      type: 'discount',
      rewardValue: '12.50',
      maxBudget: '1000.00',
      limitPer: 'visit',
      cooldownSeconds: 30,
    });
    expect(persisted!.startDate).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(persisted!.expiryDate).toEqual(new Date('2026-09-30T00:00:00.000Z'));
  });

  it('create() rejects a branchId that belongs to a different business', async () => {
    const branchB = await repos.branches.create({
      businessId: businessB,
      name: 'Business B branch',
      slug: `reward-test-branch-b-${crypto.randomUUID()}`,
    });

    await expect(
      service.create(
        businessA,
        { name: 'Cross-tenant reward', pointsCost: 10, branchId: branchB.id },
        STAFF_ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', status: 404 });
  });

  it("update() applies a partial patch without clearing other campaign fields already persisted -- proves Drizzle skips undefined keys rather than nulling them", async () => {
    const created = await service.create(
      businessA,
      {
        name: 'Multi-field voucher',
        type: 'voucher',
        rewardValue: 20,
        maxRewardsPerDay: 5,
        cooldownSeconds: 300,
      },
      STAFF_ACTOR_ID,
    );

    const updated = await service.update(created.id, businessA, { maxBudget: 750 }, STAFF_ACTOR_ID);

    expect(updated.maxBudget).toBe('750.00'); // the one field this patch touched
    expect(updated.type).toBe('voucher'); // everything else survives untouched
    expect(updated.rewardValue).toBe('20.00');
    expect(updated.maxRewardsPerDay).toBe(5);
    expect(updated.cooldownSeconds).toBe(300);
  });
});
