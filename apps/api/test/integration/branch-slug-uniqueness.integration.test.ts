import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/**
 * Verifies the businessId+slug UNIQUE INDEX (branches.ts's
 * `branches_business_id_slug_key`) actually exists in the database and is
 * enforced by Postgres itself -- not just by BranchService's application-
 * level findBySlug-then-create check. That check exists to return a clean
 * 409 instead of a raw constraint-violation error (see branch.service.ts's
 * comment), but it can't protect against a race between two concurrent
 * creates reaching the database with the same slug at the same instant;
 * only the database constraint can. This is exactly the kind of property a
 * fake-repository unit test (branch.service.test.ts) can never verify --
 * fakes have no constraints at all, so they'd pass even if the migration
 * that creates this index had never been written.
 */
describe.skipIf(!process.env.DATABASE_URL)('branch slug uniqueness (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let otherBusinessId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'Slug Uniqueness Test Business',
      slug: `slug-uniqueness-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;

    const otherBusiness = await repos.businesses.create({
      name: 'Slug Uniqueness Test Business (other)',
      slug: `slug-uniqueness-test-other-${crypto.randomUUID()}`,
    });
    otherBusinessId = otherBusiness.id;
  });

  afterAll(async () => {
    // Soft-delete only (no hard-delete method exists on any repository, by
    // design) -- point DATABASE_URL at a scratch/dev database only, never
    // production; repeated runs accumulate soft-deleted rows.
    await repos.businesses.softDelete(businessId, businessId);
    await repos.businesses.softDelete(otherBusinessId, businessId);
    await client.end();
  });

  it('rejects a second branch with the same slug at the same business, at the database level', async () => {
    await repos.branches.create({
      businessId,
      name: 'Main',
      slug: 'db-constraint-test',
    });

    await expect(
      repos.branches.create({
        businessId,
        name: 'Main Again',
        slug: 'db-constraint-test',
      }),
    ).rejects.toThrow();
  });

  it('allows the identical slug at a different business -- the index is scoped to (business_id, slug), not slug alone', async () => {
    await expect(
      repos.branches.create({
        businessId: otherBusinessId,
        name: 'Main',
        slug: 'db-constraint-test',
      }),
    ).resolves.toMatchObject({ slug: 'db-constraint-test', businessId: otherBusinessId });
  });
});
