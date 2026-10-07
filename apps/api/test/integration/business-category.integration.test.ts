import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

describe.skipIf(!process.env.DATABASE_URL)('business category authority (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'Business Category Test',
      slug: `business-category-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it('seeds the strict categories used by the architecture', async () => {
    const categories = await repos.businessCategories.listActive();
    const keys = new Set(categories.map((category) => category.key));
    for (const key of ['restaurant', 'cafe', 'bakery', 'fast_food', 'catering', 'salon', 'hotel']) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it('keeps restaurant and cafe distinct even though both are food_and_beverage', async () => {
    const restaurant = await repos.businessCategories.findByKey('restaurant');
    const cafe = await repos.businessCategories.findByKey('cafe');
    expect(restaurant).toBeDefined();
    expect(cafe).toBeDefined();
    expect(restaurant?.groupKey).toBe('food_and_beverage');
    expect(cafe?.groupKey).toBe('food_and_beverage');
    expect(restaurant?.id).not.toBe(cafe?.id);
  });

  it('links a business to an authoritative category without changing tenant identity', async () => {
    const category = await repos.businessCategories.findByKey('restaurant');
    expect(category).toBeDefined();
    const updated = await repos.businesses.update(
      businessId,
      { ...(category ? { categoryId: category.id } : {}) },
      businessId,
    );
    expect(updated?.id).toBe(businessId);
    expect(updated?.categoryId).toBe(category?.id);
  });
});
