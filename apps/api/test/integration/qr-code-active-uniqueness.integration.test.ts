import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/**
 * Verifies qr_codes' partial unique index (qr_codes_branch_type_active_key,
 * `ON (branch_id, type) WHERE status = 'active'`) actually exists in the
 * database and is enforced by Postgres itself -- not just by
 * QrCodeService.getOrCreateActiveForBranch's application-level check-then-
 * create. That check exists to make the common path simple, but it can't
 * protect against a race between two concurrent regenerate calls reaching
 * the database at the same instant; only the database constraint can. Same
 * reasoning as Branch Mgmt Block 6's branch-slug-uniqueness integration
 * test -- a fake-repository unit test (qr-code.service.test.ts) can never
 * verify this, since fakes have no constraints at all.
 */
describe.skipIf(!process.env.DATABASE_URL)('qr_codes active-per-branch uniqueness (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'QR Uniqueness Test Business',
      slug: `qr-uniqueness-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;
  });

  afterAll(async () => {
    // Soft-delete only (no hard-delete method exists on any repository, by
    // design) -- point DATABASE_URL at a scratch/dev database only.
    await repos.businesses.softDelete(businessId, businessId);
    await client.end();
  });

  it('rejects a second ACTIVE code for the same branch+type at the database level', async () => {
    const branch = await repos.branches.create({
      businessId,
      name: 'Main',
      slug: `qr-uniqueness-branch-${crypto.randomUUID()}`,
    });

    await repos.qrCodes.create({
      businessId,
      branchId: branch.id,
      token: `db-constraint-test-${crypto.randomUUID()}`,
    });

    await expect(
      repos.qrCodes.create({
        businessId,
        branchId: branch.id,
        token: `db-constraint-test-2-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  });

  it('allows a second code for the same branch once the first is revoked -- the index is scoped to active rows only', async () => {
    const branch = await repos.branches.create({
      businessId,
      name: 'Second',
      slug: `qr-uniqueness-branch-2-${crypto.randomUUID()}`,
    });

    const first = await repos.qrCodes.create({
      businessId,
      branchId: branch.id,
      token: `db-constraint-test-3-${crypto.randomUUID()}`,
    });
    await repos.qrCodes.revoke(first.id, businessId, businessId);

    await expect(
      repos.qrCodes.create({
        businessId,
        branchId: branch.id,
        token: `db-constraint-test-4-${crypto.randomUUID()}`,
      }),
    ).resolves.toMatchObject({ status: 'active' });
  });
});
