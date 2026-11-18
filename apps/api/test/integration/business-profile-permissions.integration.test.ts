import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';

type RoleName = 'Owner' | 'Admin' | 'Manager' | 'Staff';
const PROFILE_KEYS = ['profile:edit', 'profile:submit'] as const;

/**
 * BDPN-01B part 2 (D-02) against REAL Postgres: a business provisioned through the real RoleProvisioningService gives
 * `profile:edit` and `profile:submit` to Owner and Admin ONLY, they need business-wide access, and the platform
 * moderation key `profile:moderate` is never a business permission. Requires the permission catalog to be seeded (as CI
 * does before the integration step).
 */
describe.skipIf(!process.env.DATABASE_URL)('business profile permission resolution (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let branchId: string;
  const userIds = {} as Record<RoleName, string>;
  let branchAdminId: string;

  const newUser = async (label: string) =>
    (await repos.users.create({
      email: `bdpn-profile-${label}-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      fullName: `BDPN profile ${label}`,
      status: 'active',
    })).id;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'BDPN Profile Permission Test',
      slug: `bdpn-profile-permission-${crypto.randomUUID()}`,
    });
    businessId = business.id;
    branchId = (await repos.branches.create({
      businessId,
      name: 'Profile Branch',
      slug: `profile-branch-${crypto.randomUUID()}`,
    })).id;

    userIds.Owner = await newUser('owner');
    const roleIds = await new RoleProvisioningService(repos).seedDefaultRoles(businessId, userIds.Owner);
    await repos.userBusinessRoles.grant({ userId: userIds.Owner, businessId, branchId: null, roleId: roleIds.Owner, createdBy: userIds.Owner });

    for (const roleName of ['Admin', 'Manager', 'Staff'] as const) {
      userIds[roleName] = await newUser(roleName.toLowerCase());
      await repos.userBusinessRoles.grant({
        userId: userIds[roleName],
        businessId,
        branchId: roleName === 'Manager' ? branchId : null,
        roleId: roleIds[roleName],
        createdBy: userIds.Owner,
      });
    }

    // An Admin role granted only at a branch (not business-wide).
    branchAdminId = await newUser('branch-admin');
    await repos.userBusinessRoles.grant({ userId: branchAdminId, businessId, branchId, roleId: roleIds.Admin, createdBy: userIds.Owner });
  });

  afterAll(async () => {
    await client.end();
  });

  it('the permission catalog contains both business keys and no moderation key', async () => {
    const catalog = (await repos.permissions.listAll()).map((p) => p.key);
    for (const key of PROFILE_KEYS) expect(catalog).toContain(key);
    expect(catalog).not.toContain('profile:moderate');
  });

  for (const roleName of ['Owner', 'Admin'] as const) {
    it(`${roleName} resolves profile:edit and profile:submit with business-wide access`, async () => {
      const keys = await repos.permissions.findEffectiveKeys(userIds[roleName], businessId);
      for (const key of PROFILE_KEYS) expect(keys.has(key), `${roleName} ${key}`).toBe(true);
    });
  }

  it('Manager resolves neither key, with or without its branch context', async () => {
    for (const keys of [
      await repos.permissions.findEffectiveKeys(userIds.Manager, businessId, branchId),
      await repos.permissions.findEffectiveKeys(userIds.Manager, businessId),
    ]) {
      for (const key of PROFILE_KEYS) expect(keys.has(key)).toBe(false);
    }
  });

  it('Staff resolves neither key', async () => {
    const keys = await repos.permissions.findEffectiveKeys(userIds.Staff, businessId);
    for (const key of PROFILE_KEYS) expect(keys.has(key)).toBe(false);
  });

  it('an Admin granted only at a branch has no profile authority without a trusted branch context', async () => {
    const keys = await repos.permissions.findEffectiveKeys(branchAdminId, businessId);
    for (const key of PROFILE_KEYS) expect(keys.has(key), key).toBe(false);
  });

  it('no business role ever resolves the platform moderation key', async () => {
    for (const roleName of ['Owner', 'Admin', 'Manager', 'Staff'] as const) {
      const keys = await repos.permissions.findEffectiveKeys(userIds[roleName], businessId, roleName === 'Manager' ? branchId : undefined);
      expect(keys.has('profile:moderate'), roleName).toBe(false);
    }
  });
});
