import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { BranchService } from '../../src/branches/branch.service';

/**
 * ONBOARDING-UX-01 against REAL Postgres: generated slugs, deterministic duplicate handling, retry / double-submit
 * protection under real concurrency, explicit-slug refusal, soft-deleted collisions, and that established slugs are never
 * touched. Rows carry a per-run tag; everything created is removed afterwards.
 */
describe.skipIf(!process.env.DATABASE_URL)('onboarding slug generation (integration)', () => {
  const RUN = Date.now().toString(36);
  let a: Client;
  let b: Client;
  const businessIds: string[] = [];
  const userIds: string[] = [];
  let owner1: string;
  let owner2: string;

  const newUser = async (label: string) => {
    const id = (await a.query<{ id: string }>(
      'INSERT INTO users(email,password_hash,full_name,status) VALUES($1,$2,$3,$4) RETURNING id',
      [`slug-${label}-${RUN}@example.test`, 'unused', label, 'active'],
    )).rows[0]!.id;
    userIds.push(id);
    return id;
  };
  const business = (client: Client, owner: string, name: string, slug?: string) =>
    new BusinessService(buildDb(client)).createBusiness(slug ? { name, slug } : { name }, owner);
  const branch = (client: Client, businessId: string, owner: string, name: string, slug?: string) => {
    const db = buildDb(client);
    return db.transaction((tx) =>
      new BranchService(createRepositories(tx)).createBranch(businessId, slug ? { name, slug } : { name }, owner));
  };
  const track = <T extends { businessId: string }>(r: T) => { businessIds.push(r.businessId); return r; };
  const unique = (label: string) => `${label} ${RUN}`;
  const slugOf = (label: string) => unique(label).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  beforeAll(async () => {
    a = new Client({ connectionString: process.env.DATABASE_URL });
    b = new Client({ connectionString: process.env.DATABASE_URL });
    await a.connect();
    await b.connect();
    owner1 = await newUser('owner1');
    owner2 = await newUser('owner2');
  });

  afterAll(async () => {
    for (const id of businessIds) {
      for (const table of ['user_business_roles', 'business_subscriptions', 'branches', 'roles']) {
        await a.query(`DELETE FROM ${table} WHERE business_id = $1`, [id]).catch(() => undefined);
      }
      await a.query('DELETE FROM businesses WHERE id = $1', [id]).catch(() => undefined);
    }
    await a.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => undefined);
    await a.end();
    await b.end();
  });

  describe('businesses', () => {
    it('registers with no slug: one is generated from the name and stored', async () => {
      const created = track(await business(a, owner1, `Joe’s Café & Bar ${RUN}`));
      expect(created.replayed).toBe(false);
      expect(created.slug).toBe(`joe-s-cafe-and-bar-${RUN}`);
      const row = (await a.query('SELECT slug, name FROM businesses WHERE id=$1', [created.businessId])).rows[0];
      expect(row.slug).toBe(created.slug);
    });

    it('two different owners with the same name get deterministic, distinct slugs (-2) and no error', async () => {
      const name = unique('Twin Bakery');
      const first = track(await business(a, owner1, name));
      const second = track(await business(a, owner2, name));
      expect(first.slug).toBe(slugOf('Twin Bakery'));
      expect(second.slug).toBe(`${slugOf('Twin Bakery')}-2`);
    });

    it('concurrent registrations of the same name by DIFFERENT owners both succeed with different slugs', async () => {
      const name = unique('Race Cafe');
      const [x, y] = await Promise.all([business(a, owner1, name), business(b, owner2, name)]);
      track(x); track(y);
      expect(new Set([x.slug, y.slug]).size).toBe(2);
      expect([x.slug, y.slug].sort()).toEqual([slugOf('Race Cafe'), `${slugOf('Race Cafe')}-2`].sort());
    });

    it('a double submit (concurrent retry) by the SAME owner creates exactly one business and returns it twice', async () => {
      const name = unique('Double Submit Deli');
      const [x, y] = await Promise.all([business(a, owner1, name), business(b, owner1, name)]);
      track(x);
      expect(x.businessId).toBe(y.businessId);
      expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
      const n = (await a.query("SELECT count(*)::int n FROM businesses WHERE created_by=$1 AND lower(name)=lower($2)", [owner1, name])).rows[0].n;
      expect(n).toBe(1);
      const roles = (await a.query('SELECT count(*)::int n FROM user_business_roles WHERE business_id=$1 AND user_id=$2', [x.businessId, owner1])).rows[0].n;
      expect(roles).toBe(1);
    });

    it('an explicit canonical slug is honoured exactly', async () => {
      const slug = `chosen-${RUN}`;
      const created = track(await business(a, owner1, unique('Chosen Name'), slug));
      expect(created.slug).toBe(slug);
    });

    it('an explicit slug that is taken is refused with an actionable 409 and creates NOTHING (never silently renamed)', async () => {
      const slug = `taken-${RUN}`;
      track(await business(a, owner1, unique('Holder'), slug));
      const before = (await a.query('SELECT count(*)::int n FROM businesses')).rows[0].n;
      await expect(business(a, owner2, unique('Claimant'), slug)).rejects.toMatchObject({ status: 409, code: 'SLUG_TAKEN' });
      expect((await a.query('SELECT count(*)::int n FROM businesses')).rows[0].n).toBe(before);
      expect((await a.query('SELECT count(*)::int n FROM roles WHERE business_id IS NOT NULL AND name = $1', ['__none__'])).rows[0].n).toBe(0);
    });

    it('a soft-deleted business that holds a slug does not cause a failure: the next candidate is used', async () => {
      const name = unique('Ghost Shop');
      const ghost = track(await business(a, owner1, name));
      await a.query('UPDATE businesses SET is_deleted = true, deleted_at = now() WHERE id = $1', [ghost.businessId]);
      const next = track(await business(a, owner2, name));
      expect(next.slug).toBe(`${ghost.slug}-2`);
    });

    it('a failed creation leaves no partial business behind (invalid category rolls everything back)', async () => {
      const name = unique('Rollback Co');
      const before = (await a.query('SELECT count(*)::int n FROM businesses')).rows[0].n;
      await expect(
        new BusinessService(buildDb(a)).createBusiness({ name, categoryKey: 'definitely-not-a-category' } as never, owner1),
      ).rejects.toMatchObject({ code: 'INVALID_BUSINESS_CATEGORY' });
      expect((await a.query('SELECT count(*)::int n FROM businesses')).rows[0].n).toBe(before);
    });

    it('existing slugs are never changed by new registrations', async () => {
      const keep = track(await business(a, owner1, unique('Established')));
      const snapshot = (await a.query('SELECT slug FROM businesses WHERE id=$1', [keep.businessId])).rows[0].slug;
      for (let i = 0; i < 3; i += 1) track(await business(a, owner2, unique('Established')));
      expect((await a.query('SELECT slug FROM businesses WHERE id=$1', [keep.businessId])).rows[0].slug).toBe(snapshot);
    });

    it('a name with no Latin characters still registers (fallback + suffix)', async () => {
      const first = track(await business(a, owner1, 'مقهى النخيل'));
      expect(first.slug).toMatch(/^business(-\d+)?$/);
    });
  });

  describe('branches', () => {
    let biz1: string;
    let biz2: string;
    beforeAll(async () => {
      biz1 = track(await business(a, owner1, unique('Branch Host One'))).businessId;
      biz2 = track(await business(a, owner1, unique('Branch Host Two'))).businessId;
    });

    it('the first branch is created with no slug', async () => {
      const created = await branch(a, biz1, owner1, 'Main Street');
      expect(created.slug).toBe('main-street');
      expect(created.businessId).toBe(biz1);
    });

    it('the same name at the same business gets -2 (a different user, so it is not a retry)', async () => {
      const again = await branch(a, biz1, owner2, 'Main Street');
      expect(again.slug).toBe('main-street-2');
    });

    it('the same slug is allowed at a different business (uniqueness is per tenant)', async () => {
      expect((await branch(a, biz2, owner1, 'Main Street')).slug).toBe('main-street');
    });

    it('a double submit of the same branch name creates exactly one branch', async () => {
      const [x, y] = await Promise.all([branch(a, biz1, owner1, 'Harbor Road'), branch(b, biz1, owner1, 'Harbor Road')]);
      expect(x.id).toBe(y.id);
      const n = (await a.query("SELECT count(*)::int n FROM branches WHERE business_id=$1 AND lower(name)='harbor road'", [biz1])).rows[0].n;
      expect(n).toBe(1);
    });

    it('concurrent same-name creates by different users both succeed with different slugs', async () => {
      const [x, y] = await Promise.all([branch(a, biz2, owner1, 'Airport Kiosk'), branch(b, biz2, owner2, 'Airport Kiosk')]);
      expect(new Set([x.slug, y.slug]).size).toBe(2);
    });

    it('an explicit slug that is already used returns an actionable 409 and creates nothing', async () => {
      await branch(a, biz1, owner1, 'Explicit One', 'explicit-slug');
      const before = (await a.query('SELECT count(*)::int n FROM branches WHERE business_id=$1', [biz1])).rows[0].n;
      await expect(branch(a, biz1, owner2, 'Explicit Two', 'explicit-slug')).rejects.toMatchObject({ status: 409, code: 'SLUG_TAKEN' });
      expect((await a.query('SELECT count(*)::int n FROM branches WHERE business_id=$1', [biz1])).rows[0].n).toBe(before);
    });

    it('a soft-deleted branch holding a slug does not break creation', async () => {
      const first = await branch(a, biz1, owner1, 'Pop Up');
      await a.query('UPDATE branches SET is_deleted = true, deleted_at = now() WHERE id = $1', [first.id]);
      const next = await branch(a, biz1, owner2, 'Pop Up');
      expect(next.slug).toBe(`${first.slug}-2`);
    });

    it('existing branch slugs are untouched', async () => {
      const before = (await a.query('SELECT id, slug FROM branches WHERE business_id=$1 ORDER BY id', [biz1])).rows;
      await branch(a, biz1, owner2, 'Another Place');
      const after = (await a.query('SELECT id, slug FROM branches WHERE business_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [biz1, before.map((r) => r.id)])).rows;
      expect(after).toEqual(before);
    });
  });
});
