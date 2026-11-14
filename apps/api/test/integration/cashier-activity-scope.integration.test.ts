import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { resolveActivityScope } from '../../src/cashier-activity/scope';

/**
 * SEC-CASHIER-R1 F1 against REAL Postgres (DATABASE_URL, scratch database only): the per-branch visibility rule runs on
 * the real effective-permission SQL and the real default roles (Owner, Admin, Manager, Staff), not on a mock of them.
 * Requires migrations and the permission catalog seed.
 */
describe.skipIf(!process.env.DATABASE_URL)('cashier activity scope (integration, scratch database)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let otherBusinessId: string;
  let branchA: string;
  let branchB: string;
  let roles: Record<'Owner' | 'Admin' | 'Manager' | 'Staff', string>;
  const users: Record<string, string> = {};

  const newUser = async (name: string) => {
    const u = await repos.users.create({
      email: `scope-${name}-${randomUUID()}@example.test`,
      passwordHash: 'x',
      fullName: name,
      status: 'active',
    });
    users[name] = u.id;
    return u.id;
  };
  const grant = (userId: string, role: keyof typeof roles, branchId: string | null) =>
    repos.userBusinessRoles.grant({ userId, businessId, branchId, roleId: roles[role], createdBy: userId });
  const scope = (name: string) => resolveActivityScope(repos, users[name]!, businessId);
  const sorted = (ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const founder = await newUser('founder');
    businessId = (await repos.businesses.create({ name: 'Scope Test', slug: `scope-${randomUUID()}` })).id;
    otherBusinessId = (await repos.businesses.create({ name: 'Scope Other', slug: `scope-o-${randomUUID()}` })).id;
    branchA = (await repos.branches.create({ businessId, name: 'A', slug: 'a' })).id;
    branchB = (await repos.branches.create({ businessId, name: 'B', slug: 'b' })).id;
    roles = (await new RoleProvisioningService(repos).seedDefaultRoles(businessId, founder)) as typeof roles;

    for (const name of ['owner', 'admin', 'managerWide', 'staffWide', 'maSb', 'maMb', 'saMb', 'wideStaffMa', 'none']) {
      await newUser(name);
    }
    await grant(users.owner!, 'Owner', null);
    await grant(users.admin!, 'Admin', null);
    await grant(users.managerWide!, 'Manager', null);
    await grant(users.staffWide!, 'Staff', null);
    await grant(users.maSb!, 'Manager', branchA);
    await grant(users.maSb!, 'Staff', branchB);
    await grant(users.maMb!, 'Manager', branchA);
    await grant(users.maMb!, 'Manager', branchB);
    await grant(users.saMb!, 'Staff', branchA);
    await grant(users.saMb!, 'Manager', branchB);
    await grant(users.wideStaffMa!, 'Staff', null);
    await grant(users.wideStaffMa!, 'Manager', branchA);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('business-wide Owner, Admin and Manager see every branch; business-wide Staff sees none', async () => {
    for (const name of ['owner', 'admin', 'managerWide']) expect(await scope(name), name).toEqual({ all: true, branchIds: [] });
    expect(await scope('staffWide')).toEqual({ all: false, branchIds: [] });
  });

  it('Manager at A / Staff at B sees only A (the Staff role at B grants nothing)', async () => {
    expect(await scope('maSb')).toEqual({ all: false, branchIds: [branchA] });
  });

  it('Manager at A / Manager at B sees both; Staff at A / Manager at B sees only B', async () => {
    expect(sorted((await scope('maMb')).branchIds)).toEqual(sorted([branchA, branchB]));
    expect(await scope('saMb')).toEqual({ all: false, branchIds: [branchB] });
  });

  it('business-wide Staff who is Manager at A sees A only', async () => {
    expect(await scope('wideStaffMa')).toEqual({ all: false, branchIds: [branchA] });
  });

  it('a user with no grant, and a user of another business, see nothing', async () => {
    expect(await scope('none')).toEqual({ all: false, branchIds: [] });
    expect(await resolveActivityScope(repos, users.owner!, otherBusinessId)).toEqual({ all: false, branchIds: [] });
  });
});
