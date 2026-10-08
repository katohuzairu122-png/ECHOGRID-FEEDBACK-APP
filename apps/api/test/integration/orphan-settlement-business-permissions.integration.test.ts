import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';

type RoleName = 'Owner' | 'Admin' | 'Manager' | 'Staff';
const MANAGEMENT_ROLES: RoleName[] = ['Owner', 'Admin', 'Manager'];

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 06 settlement permission resolution (integration)',
  () => {
    let client: Client;
    let repos: ReturnType<typeof createRepositories>;
    let businessId: string;
    let branchId: string;
    const userIds = {} as Record<RoleName, string>;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      repos = createRepositories(buildDb(client));

      const business = await repos.businesses.create({
        name: 'Split 06 Settlement Permission Test',
        slug: `split06-settlement-permission-${crypto.randomUUID()}`,
      });
      businessId = business.id;

      const branch = await repos.branches.create({
        businessId,
        name: 'Settlement Branch',
        slug: `settlement-branch-${crypto.randomUUID()}`,
      });
      branchId = branch.id;

      const owner = await repos.users.create({
        email: `split06-settlement-owner-${crypto.randomUUID()}@example.test`,
        passwordHash: 'not-a-real-hash',
        fullName: 'Split 06 Settlement Owner',
        status: 'active',
      });
      userIds.Owner = owner.id;

      const roleIds = await new RoleProvisioningService(
        repos,
      ).seedDefaultRoles(businessId, owner.id);

      await repos.userBusinessRoles.grant({
        userId: owner.id,
        businessId,
        branchId: null,
        roleId: roleIds.Owner,
        createdBy: owner.id,
      });

      for (const roleName of ['Admin', 'Manager', 'Staff'] as const) {
        const user = await repos.users.create({
          email: `split06-settlement-${roleName.toLowerCase()}-${crypto.randomUUID()}@example.test`,
          passwordHash: 'not-a-real-hash',
          fullName: `Split 06 Settlement ${roleName}`,
          status: 'active',
        });
        userIds[roleName] = user.id;

        await repos.userBusinessRoles.grant({
          userId: user.id,
          businessId,
          branchId: roleName === 'Manager' ? branchId : null,
          roleId: roleIds[roleName],
          createdBy: owner.id,
        });
      }
    });

    afterAll(async () => {
      await client.end();
    });

    for (const roleName of MANAGEMENT_ROLES) {
      it(`${roleName} resolves settlement:view/accept/fulfill in its authorized scope`, async () => {
        const keys = await repos.permissions.findEffectiveKeys(
          userIds[roleName],
          businessId,
          roleName === 'Manager' ? branchId : undefined,
        );

        expect(keys.has('settlement:view')).toBe(true);
        expect(keys.has('settlement:accept')).toBe(true);
        expect(keys.has('settlement:fulfill')).toBe(true);
      });
    }

    it('branch-scoped Manager has no settlement authority without trusted branch context', async () => {
      const keys = await repos.permissions.findEffectiveKeys(
        userIds.Manager,
        businessId,
      );
      expect(keys.has('settlement:view')).toBe(false);
      expect(keys.has('settlement:accept')).toBe(false);
      expect(keys.has('settlement:fulfill')).toBe(false);
    });

    it('Staff receives no settlement authority by default', async () => {
      const keys = await repos.permissions.findEffectiveKeys(
        userIds.Staff,
        businessId,
      );
      expect(keys.has('settlement:view')).toBe(false);
      expect(keys.has('settlement:accept')).toBe(false);
      expect(keys.has('settlement:fulfill')).toBe(false);
    });
  },
);
