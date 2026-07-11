import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';

type RoleName = 'Owner' | 'Admin' | 'Manager' | 'Staff';
const ROLE_NAMES: RoleName[] = ['Owner', 'Admin', 'Manager', 'Staff'];

/**
 * Verifies the specific Owner/Admin billing cut this project deliberately
 * made in DEFAULT_ROLES (see role-provisioning.service.ts's comment): Owner
 * gets both billing:view and billing:manage, Admin gets billing:view only,
 * Manager/Staff get neither. Same reasoning as
 * permission-resolution.integration.test.ts for running this against real
 * Postgres rather than a fake -- the thing under test is
 * PermissionRepository.findEffectiveKeys' JOIN across
 * user_business_roles -> roles -> role_permissions -> permissions, which a
 * fake would silently re-encode rather than verify.
 *
 * Requires migrations applied (`pnpm db:migrate`) and the permission catalog
 * seeded (`pnpm db:seed`, which now includes billing:view/billing:manage --
 * see permissions.seed.ts) first. Point at a scratch/dev database, never
 * production -- cleanup only soft-deletes, same caveat as the precedent test.
 */
describe.skipIf(!process.env.DATABASE_URL)('billing permission resolution (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  const userIds = {} as Record<RoleName, string>;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'Billing Permission Test Business',
      slug: `billing-permission-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;

    const ownerUser = await repos.users.create({
      email: `billing-test-owner-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Billing Test Owner',
      status: 'active',
    });
    userIds.Owner = ownerUser.id;

    const roleProvisioning = new RoleProvisioningService(repos);
    const roleIds = await roleProvisioning.seedDefaultRoles(businessId, ownerUser.id);

    await repos.userBusinessRoles.grant({
      userId: ownerUser.id,
      businessId,
      branchId: null, // business-wide
      roleId: roleIds.Owner,
      createdBy: ownerUser.id,
    });

    for (const roleName of ['Admin', 'Manager', 'Staff'] as const) {
      const user = await repos.users.create({
        email: `billing-test-${roleName.toLowerCase()}-${crypto.randomUUID()}@example.test`,
        passwordHash: 'not-a-real-hash',
        fullName: `Billing Test ${roleName}`,
        status: 'active',
      });
      userIds[roleName] = user.id;

      await repos.userBusinessRoles.grant({
        userId: user.id,
        businessId,
        branchId: null,
        roleId: roleIds[roleName],
        createdBy: ownerUser.id,
      });
    }
  });

  afterAll(async () => {
    for (const roleName of ROLE_NAMES) {
      await repos.users.softDelete(userIds[roleName], userIds.Owner);
    }
    await repos.businesses.softDelete(businessId, userIds.Owner);
    await client.end();
  });

  it('Owner resolves both billing:view and billing:manage', async () => {
    const keys = await repos.permissions.findEffectiveKeys(userIds.Owner, businessId);
    expect(keys.has('billing:view')).toBe(true);
    expect(keys.has('billing:manage')).toBe(true);
  });

  it('Admin resolves billing:view but NOT billing:manage -- the one deliberate cut from Owner', async () => {
    const keys = await repos.permissions.findEffectiveKeys(userIds.Admin, businessId);
    expect(keys.has('billing:view')).toBe(true);
    expect(keys.has('billing:manage')).toBe(false);
  });

  it('Manager resolves neither billing permission', async () => {
    const keys = await repos.permissions.findEffectiveKeys(userIds.Manager, businessId);
    expect(keys.has('billing:view')).toBe(false);
    expect(keys.has('billing:manage')).toBe(false);
  });

  it('Staff resolves neither billing permission', async () => {
    const keys = await repos.permissions.findEffectiveKeys(userIds.Staff, businessId);
    expect(keys.has('billing:view')).toBe(false);
    expect(keys.has('billing:manage')).toBe(false);
  });
});
