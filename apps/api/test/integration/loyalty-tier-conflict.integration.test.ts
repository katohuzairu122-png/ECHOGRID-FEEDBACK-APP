import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyTierService } from '../../src/loyalty/loyalty-tier.service';

const STAFF_ACTOR_ID = crypto.randomUUID();

/**
 * Uses two real PostgreSQL sessions so the unique index, including concurrent
 * inserts, is authoritative. An isolated disposable DB is required; this suite
 * intentionally skips when DATABASE_URL is absent.
 */
describe.skipIf(!process.env.DATABASE_URL)('Loyalty tier name conflicts (integration)', () => {
  let clientA: Client;
  let clientB: Client;
  let reposA: ReturnType<typeof createRepositories>;
  let serviceA: LoyaltyTierService;
  let serviceB: LoyaltyTierService;
  let businessA: string;
  let businessB: string;

  beforeAll(async () => {
    clientA = new Client({ connectionString: process.env.DATABASE_URL });
    clientB = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([clientA.connect(), clientB.connect()]);

    reposA = createRepositories(buildDb(clientA));
    serviceA = new LoyaltyTierService(reposA);
    serviceB = new LoyaltyTierService(createRepositories(buildDb(clientB)));

    const first = await reposA.businesses.create({
      name: 'F1 Loyalty Tier Test A',
      slug: `f1-tier-a-${crypto.randomUUID()}`,
    });
    const second = await reposA.businesses.create({
      name: 'F1 Loyalty Tier Test B',
      slug: `f1-tier-b-${crypto.randomUUID()}`,
    });
    businessA = first.id;
    businessB = second.id;
  });

  afterAll(async () => {
    if (reposA && businessA) await reposA.businesses.softDelete(businessA, businessA);
    if (reposA && businessB) await reposA.businesses.softDelete(businessB, businessB);
    if (clientA) await clientA.end();
    if (clientB) await clientB.end();
  });

  it('returns an exact 409 conflict on duplicate creation without a second row', async () => {
    await serviceA.create(businessA, { name: 'Bronze', minPoints: 0 }, STAFF_ACTOR_ID);

    await expect(
      serviceA.create(businessA, { name: 'Bronze', minPoints: 0 }, STAFF_ACTOR_ID),
    ).rejects.toMatchObject({ status: 409, code: 'LOYALTY_TIER_ALREADY_EXISTS' });

    const rows = await serviceA.list(businessA);
    expect(rows.filter((tier) => tier.name === 'Bronze')).toHaveLength(1);
  });

  it('allows two businesses to use the same tier name without crossing tenants', async () => {
    await serviceA.create(businessA, { name: 'Silver', minPoints: 100 }, STAFF_ACTOR_ID);
    const other = await serviceB.create(
      businessB,
      { name: 'Silver', minPoints: 100 },
      STAFF_ACTOR_ID,
    );
    expect(other.businessId).toBe(businessB);
  });

  it('returns 409 on an update that conflicts with an existing name', async () => {
    const gold = await serviceA.create(businessA, { name: 'Gold', minPoints: 500 }, STAFF_ACTOR_ID);

    await expect(
      serviceA.update(gold.id, businessA, { name: 'Silver' }, STAFF_ACTOR_ID),
    ).rejects.toMatchObject({ status: 409, code: 'LOYALTY_TIER_ALREADY_EXISTS' });

    expect((await serviceA.list(businessA)).find((tier) => tier.id === gold.id)?.name).toBe(
      'Gold',
    );
  });

  it('permits exactly one of two simultaneous writes with the same name', async () => {
    const results = await Promise.allSettled([
      serviceA.create(businessA, { name: 'Concurrent', minPoints: 700 }, STAFF_ACTOR_ID),
      serviceB.create(businessA, { name: 'Concurrent', minPoints: 700 }, STAFF_ACTOR_ID),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'LOYALTY_TIER_ALREADY_EXISTS' },
    });
    expect((await serviceA.list(businessA)).filter((tier) => tier.name === 'Concurrent')).toHaveLength(
      1,
    );
  });

  it('preserves existing name reservation for soft-deleted tiers (no schema change)', async () => {
    const tier = await serviceA.create(businessA, { name: 'Archived', minPoints: 0 }, STAFF_ACTOR_ID);
    await serviceA.remove(tier.id, businessA, STAFF_ACTOR_ID);

    await expect(
      serviceA.create(businessA, { name: 'Archived', minPoints: 0 }, STAFF_ACTOR_ID),
    ).rejects.toMatchObject({ status: 409, code: 'LOYALTY_TIER_ALREADY_EXISTS' });

    expect((await serviceA.list(businessA)).some((row) => row.name === 'Archived')).toBe(false);
  });
});
