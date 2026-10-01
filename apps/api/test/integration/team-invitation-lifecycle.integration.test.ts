import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { hashToken } from '../../src/auth/token-hash';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';

/**
 * Exercises the team invitation journey against real Postgres. The route
 * layer handles authentication and email delivery; this suite verifies the
 * durable state transitions and permission boundaries those routes depend on.
 */
describe.skipIf(!process.env.DATABASE_URL)('team invitation lifecycle (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let ownerUserId: string;
  let invitedUserId: string;
  let primaryBusinessId: string;
  let invitedBusinessId: string;
  let branchAId: string;
  let branchBId: string;
  let invitedRoleIds: Awaited<ReturnType<RoleProvisioningService['seedDefaultRoles']>>;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const owner = await repos.users.create({
      email: `team-owner-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Team Lifecycle Owner',
      status: 'active',
    });
    ownerUserId = owner.id;

    const invitedUser = await repos.users.create({
      email: `team-member-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      fullName: 'Team Lifecycle Member',
      status: 'active',
    });
    invitedUserId = invitedUser.id;

    const primaryBusiness = await repos.businesses.create({
      name: 'Team Lifecycle Primary Business',
      slug: `team-primary-${crypto.randomUUID()}`,
    });
    primaryBusinessId = primaryBusiness.id;

    const invitedBusiness = await repos.businesses.create({
      name: 'Team Lifecycle Invited Business',
      slug: `team-invited-${crypto.randomUUID()}`,
    });
    invitedBusinessId = invitedBusiness.id;

    const primaryRoleIds = await new RoleProvisioningService(repos).seedDefaultRoles(primaryBusinessId, ownerUserId);
    invitedRoleIds = await new RoleProvisioningService(repos).seedDefaultRoles(invitedBusinessId, ownerUserId);

    await repos.userBusinessRoles.grant({
      userId: ownerUserId,
      businessId: invitedBusinessId,
      roleId: invitedRoleIds.Owner,
      branchId: null,
      createdBy: ownerUserId,
    });
    await repos.userBusinessRoles.grant({
      userId: invitedUserId,
      businessId: primaryBusinessId,
      roleId: primaryRoleIds.Staff,
      branchId: null,
      createdBy: ownerUserId,
    });

    branchAId = (await repos.branches.create({ businessId: invitedBusinessId, name: 'Branch A', slug: 'branch-a' })).id;
    branchBId = (await repos.branches.create({ businessId: invitedBusinessId, name: 'Branch B', slug: 'branch-b' })).id;
  });

  afterAll(async () => {
    await repos.businesses.softDelete(invitedBusinessId, ownerUserId);
    await repos.businesses.softDelete(primaryBusinessId, ownerUserId);
    await repos.users.softDelete(invitedUserId, ownerUserId);
    await repos.users.softDelete(ownerUserId, ownerUserId);
    await client.end();
  });

  it('rotates, accepts, scopes, changes, revokes, and cancels team access', async () => {
    const originalToken = `original-${crypto.randomUUID()}`;
    const rotatedToken = `rotated-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60_000);
    const invitedUser = await repos.users.findById(invitedUserId);
    expect(invitedUser).toBeDefined();

    const invitation = await repos.teamInvitations.create({
      businessId: invitedBusinessId,
      email: invitedUser!.email,
      roleId: invitedRoleIds.Staff,
      branchId: branchAId,
      tokenHash: await hashToken(originalToken),
      expiresAt,
      invitedBy: ownerUserId,
    });

    expect(await repos.teamInvitations.findUsableByHash(await hashToken(originalToken), new Date())).toMatchObject({ id: invitation.id });

    await repos.teamInvitations.rotate(
      invitation.id,
      invitedBusinessId,
      await hashToken(rotatedToken),
      expiresAt,
    );
    expect(await repos.teamInvitations.findUsableByHash(await hashToken(originalToken), new Date())).toBeUndefined();
    expect(await repos.teamInvitations.findUsableByHash(await hashToken(rotatedToken), new Date())).toMatchObject({ id: invitation.id });

    expect(await repos.teamInvitations.accept(invitation.id, new Date())).toBe(true);
    expect(await repos.teamInvitations.accept(invitation.id, new Date())).toBe(false);
    const branchGrant = await repos.userBusinessRoles.grant({
      userId: invitedUserId,
      businessId: invitedBusinessId,
      roleId: invitedRoleIds.Staff,
      branchId: branchAId,
      createdBy: ownerUserId,
    });

    const memberships = await repos.userBusinessRoles.listForUser(invitedUserId);
    expect(new Set(memberships.map((membership) => membership.businessId))).toEqual(
      new Set([primaryBusinessId, invitedBusinessId]),
    );
    expect((await repos.permissions.findEffectiveKeys(invitedUserId, invitedBusinessId, branchAId)).has('feedback:view')).toBe(true);
    expect((await repos.permissions.findEffectiveKeys(invitedUserId, invitedBusinessId, branchBId)).size).toBe(0);

    await repos.userBusinessRoles.revoke(branchGrant.id, ownerUserId);
    const businessWideGrant = await repos.userBusinessRoles.grant({
      userId: invitedUserId,
      businessId: invitedBusinessId,
      roleId: invitedRoleIds.Manager,
      branchId: null,
      createdBy: ownerUserId,
    });
    expect(await repos.userBusinessRoles.findActive(branchGrant.id, invitedBusinessId)).toBeUndefined();
    expect((await repos.permissions.findEffectiveKeys(invitedUserId, invitedBusinessId, branchBId)).has('analytics:view')).toBe(true);

    await repos.userBusinessRoles.revoke(businessWideGrant.id, ownerUserId);
    expect((await repos.permissions.findEffectiveKeys(invitedUserId, invitedBusinessId, branchAId)).size).toBe(0);
    expect((await repos.permissions.findEffectiveKeys(invitedUserId, primaryBusinessId)).has('feedback:view')).toBe(true);

    const cancelledToken = `cancelled-${crypto.randomUUID()}`;
    const cancelledInvitation = await repos.teamInvitations.create({
      businessId: invitedBusinessId,
      email: `cancelled-${crypto.randomUUID()}@example.test`,
      roleId: invitedRoleIds.Staff,
      branchId: branchBId,
      tokenHash: await hashToken(cancelledToken),
      expiresAt,
      invitedBy: ownerUserId,
    });
    expect(await repos.teamInvitations.cancel(cancelledInvitation.id, invitedBusinessId)).toBe(true);
    expect(await repos.teamInvitations.cancel(cancelledInvitation.id, invitedBusinessId)).toBe(false);
    expect(await repos.teamInvitations.findUsableByHash(await hashToken(cancelledToken), new Date())).toBeUndefined();
  });
});
