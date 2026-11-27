import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/** PROF-01 (migration 0109): customer profile columns, business appearance table, and their database guards. */
describe.skipIf(!process.env.DATABASE_URL)('global profiles (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let customerId: string;
  const actor = crypto.randomUUID();

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));
    businessId = (await repos.businesses.create({ name: 'Profile Test Business', slug: `prof-${crypto.randomUUID()}` })).id;
    customerId = (await repos.customers.create({ phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`, fullName: 'Prof Tester' })).id;
  });
  afterAll(async () => {
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it('a new customer has no profile fields, and the existing name is untouched', async () => {
    const c = await repos.customers.findById(customerId);
    expect(c).toMatchObject({ displayName: null, bio: null, avatarKey: null, fullName: 'Prof Tester' });
  });

  it('saves only the fields sent, and null clears one', async () => {
    await repos.customers.setGlobalProfile(customerId, { displayName: 'Amina', avatarKey: 'leaf' });
    await repos.customers.setGlobalProfile(customerId, { bio: 'Loyal to local shops.' });
    expect(await repos.customers.findById(customerId)).toMatchObject({ displayName: 'Amina', avatarKey: 'leaf', bio: 'Loyal to local shops.' });
    await repos.customers.setGlobalProfile(customerId, { avatarKey: null });
    expect(await repos.customers.findById(customerId)).toMatchObject({ displayName: 'Amina', avatarKey: null, bio: 'Loyal to local shops.' });
  });

  it('the database itself refuses an empty or over-long name, an over-long bio and a malformed key', async () => {
    const attempt = (sql: string) => client.query(sql, [customerId]);
    await expect(attempt(`update customers set display_name = '' where id = $1`)).rejects.toThrow(/customers_display_name_check/);
    await expect(attempt(`update customers set display_name = repeat('a', 61) where id = $1`)).rejects.toThrow(/customers_display_name_check/);
    await expect(attempt(`update customers set bio = repeat('a', 281) where id = $1`)).rejects.toThrow(/customers_bio_check/);
    await expect(attempt(`update customers set avatar_key = 'https://x/y.png' where id = $1`)).rejects.toThrow(/customers_avatar_key_check/);
  });

  it('a profile write never touches a deleted customer', async () => {
    const gone = await repos.customers.create({ phone: `+1556${Math.floor(1000000 + Math.random() * 8999999)}` });
    await client.query('update customers set is_deleted = true where id = $1', [gone.id]);
    expect(await repos.customers.setGlobalProfile(gone.id, { displayName: 'Ghost' })).toBeUndefined();
  });

  it('business appearance is lazy, upserts, keeps the other key on a partial save, and is guarded by the database', async () => {
    expect(await repos.businessAppearance.findByBusiness(businessId)).toBeUndefined();
    const first = await repos.businessAppearance.upsert(businessId, { logoKey: 'cup' }, actor);
    expect(first).toMatchObject({ businessId, logoKey: 'cup', brandColorKey: null, updatedBy: actor });
    const second = await repos.businessAppearance.upsert(businessId, { brandColorKey: 'teal' }, actor);
    expect(second).toMatchObject({ logoKey: 'cup', brandColorKey: 'teal' });
    const cleared = await repos.businessAppearance.upsert(businessId, { logoKey: null }, actor);
    expect(cleared).toMatchObject({ logoKey: null, brandColorKey: 'teal' });
    await expect(client.query(`update business_appearance set logo_key = '#ff0000' where business_id = $1`, [businessId])).rejects.toThrow(/business_appearance_logo_key_check/);
    const { rows } = await client.query('select count(*)::int as n from business_appearance where business_id = $1', [businessId]);
    expect(rows[0].n).toBe(1);
  });
});
