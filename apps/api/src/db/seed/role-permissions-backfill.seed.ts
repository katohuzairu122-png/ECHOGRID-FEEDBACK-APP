import 'dotenv/config';
import { Client } from 'pg';
import { and, eq } from 'drizzle-orm';
import { buildDb } from '../client';
import { roles } from '../schema';
import { PermissionRepository } from '../../repositories/permission.repository';

/**
 * One-time backfill, broader sibling of billing-permissions-backfill.seed.ts:
 * that script only patched billing:view/billing:manage onto pre-existing
 * Owner/Admin roles, on the assumption every OTHER permission was already
 * correctly granted. That assumption doesn't hold here -- the permissions
 * catalog was completely empty in production until a mid-session fix, so
 * every business created before that fix has Owner/Admin/Manager/Staff
 * roles missing MOST permissions, not just billing ones (role provisioning
 * ran against an empty catalog and silently granted nothing at all).
 *
 * Mirrors RoleProvisioningService.DEFAULT_ROLES exactly -- keep both in sync
 * if the default permission sets ever change. Only targets isSystem=true
 * roles with one of these four exact names (the rows RoleProvisioningService
 * itself creates), never a business's own renamed/custom roles. Idempotent
 * (assignManyToRole's onConflictDoNothing), safe to re-run.
 *
 * Run with: pnpm --filter @echo-grid-feedback/api db:backfill-role-permissions
 */
const DEFAULT_ROLES: Record<string, string[]> = {
  Owner: [
    'team:invite', 'team:remove', 'team:view', 'roles:manage', 'roles:view',
    'business:view', 'business:manage_settings', 'business:delete',
    'branches:view', 'branches:manage', 'audit:view',
    'feedback:view', 'feedback:manage', 'loyalty:view', 'loyalty:manage', 'rewards:manage',
    'analytics:view', 'analytics:manage', 'notifications:view', 'notifications:manage',
    'billing:view', 'billing:manage', 'messages:view', 'messages:send',
  ],
  Admin: [
    'team:invite', 'team:remove', 'team:view', 'roles:manage', 'roles:view',
    'business:view', 'business:manage_settings',
    'branches:view', 'branches:manage', 'audit:view',
    'feedback:view', 'feedback:manage', 'loyalty:view', 'loyalty:manage', 'rewards:manage',
    'analytics:view', 'analytics:manage', 'notifications:view', 'notifications:manage',
    'billing:view', 'messages:view', 'messages:send',
  ],
  Manager: [
    'team:view', 'roles:view', 'business:view',
    'branches:view', 'branches:manage',
    'feedback:view', 'feedback:manage', 'loyalty:view', 'loyalty:manage', 'rewards:manage',
    'analytics:view', 'analytics:manage', 'notifications:view', 'notifications:manage',
    'messages:view', 'messages:send',
  ],
  Staff: [
    'business:view', 'branches:view', 'feedback:view', 'loyalty:view', 'loyalty:manage',
    'messages:view', 'messages:send',
  ],
};

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const db = buildDb(client);
  const permissionRepo = new PermissionRepository(db);

  const catalog = await permissionRepo.listAll();
  const permissionIdByKey = new Map(catalog.map((p) => [p.key, p.id]));

  for (const [roleName, permissionKeys] of Object.entries(DEFAULT_ROLES)) {
    const matchingRoles = await db.query.roles.findMany({
      where: and(eq(roles.name, roleName), eq(roles.isSystem, true), eq(roles.isDeleted, false)),
    });

    const permissionIds = permissionKeys
      .map((key) => permissionIdByKey.get(key))
      .filter((id): id is string => id !== undefined);

    for (const role of matchingRoles) {
      await permissionRepo.assignManyToRole(role.id, permissionIds);
    }
    console.log(`Backfilled ${permissionIds.length} permissions onto ${matchingRoles.length} "${roleName}" role(s).`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Role permissions backfill failed:', err);
  process.exit(1);
});
