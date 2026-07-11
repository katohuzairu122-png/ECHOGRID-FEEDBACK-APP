import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';

/**
 * Runs against a real Postgres via DATABASE_URL (same connection the seed
 * script and drizzle-kit use), NOT mocked -- the thing under test
 * (PermissionRepository.findEffectiveKeys' business-wide vs. branch-scoped
 * JOIN) is exactly the kind of logic a mock would silently duplicate rather
 * than verify. Requires migrations applied (`pnpm db:migrate`) and the
 * permission catalog seeded (`pnpm db:seed`) first.
 *
 * Cleanup only soft-deletes (no hard-delete method exists on any repository,
 * by design -- see schema comments). Point this at a scratch/dev database,
 * never production; repeated runs will accumulate soft-deleted rows there.
 */
describe.skipIf(!process.env.DATABASE_URL)('permission resolution (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let ownerUserId: string;
  let branchId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const user = await repos.users.create({
      email: `test-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Integration Test User',
      status: 'active',
    });
    ownerUserId = user.id;

    const business = await repos.businesses.create({
      name: 'Integration Test Business',
      slug: `integration-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;

    const branch = await repos.branches.create({ businessId, name: 'Main', slug: 'main' });
    branchId = branch.id;

    const roleProvisioning = new RoleProvisioningService(repos);
    const roleIds = await roleProvisioning.seedDefaultRoles(businessId, ownerUserId);

    await repos.userBusinessRoles.grant({
      userId: ownerUserId,
      businessId,
      branchId: null, // business-wide
      roleId: roleIds.Owner,
      createdBy: ownerUserId,
    });
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessId, ownerUserId);
    await repos.users.softDelete(ownerUserId, ownerUserId);
    await client.end();
  });

  it('a business-wide grant resolves permissions at any branch', async () => {
    const keys = await repos.permissions.findEffectiveKeys(ownerUserId, businessId, branchId);
    // Requires `pnpm db:seed` -- Owner starts with the full catalog (see
    // DEFAULT_ROLES in role-provisioning.service.ts).
    expect(keys.has('business:delete')).toBe(true);
    expect(keys.has('branches:manage')).toBe(true);
  });

  it('a business-wide grant also resolves with no branch specified', async () => {
    const keys = await repos.permissions.findEffectiveKeys(ownerUserId, businessId);
    expect(keys.size).toBeGreaterThan(0);
  });

  it('an unrelated user has no permissions at this business', async () => {
    const keys = await repos.permissions.findEffectiveKeys(crypto.randomUUID(), businessId);
    expect(keys.size).toBe(0);
  });
});
