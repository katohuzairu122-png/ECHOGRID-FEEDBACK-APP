import 'dotenv/config';
import { Client } from 'pg';
import { eq, and } from 'drizzle-orm';
import { buildDb } from '../client';
import { roles } from '../schema';
import { PermissionRepository } from '../../repositories/permission.repository';

/**
 * One-time backfill for Billing Block 8: permissions.seed.ts's PERMISSIONS
 * array and role-provisioning.service.ts's DEFAULT_ROLES map both only take
 * effect going forward -- DEFAULT_ROLES is read once, at the moment a NEW
 * business is created. Every business created before this block shipped has
 * an Owner/Admin role that predates billing:view/billing:manage entirely,
 * so without this script their billing UI (Block 9) would 403 for everyone,
 * indistinguishable from a real bug.
 *
 * Idempotent (assignToRole already no-ops on a duplicate grant, same as
 * permissions.seed.ts's ensure()), so safe to re-run. Only targets
 * isSystem=true roles literally named "Owner"/"Admin" -- the exact rows
 * RoleProvisioningService itself creates -- never touches a business's own
 * renamed/custom roles, which this script has no business opinion about.
 *
 * Run once after deploying this block:
 *   pnpm --filter @echo-grid-feedback/api db:backfill-billing-permissions
 */
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const db = buildDb(client);
  const permissionRepo = new PermissionRepository(db);

  const billingView = await permissionRepo.ensure({
    key: 'billing:view',
    description: 'View the current plan, trial/subscription status, and billing history.',
    category: 'Billing',
  });
  const billingManage = await permissionRepo.ensure({
    key: 'billing:manage',
    description: 'Change plan, update payment method, and cancel the subscription.',
    category: 'Billing',
  });

  const ownerRoles = await db.query.roles.findMany({
    where: and(eq(roles.name, 'Owner'), eq(roles.isSystem, true), eq(roles.isDeleted, false)),
  });
  for (const role of ownerRoles) {
    await permissionRepo.assignToRole(role.id, billingView.id);
    await permissionRepo.assignToRole(role.id, billingManage.id);
  }
  console.log(`Backfilled billing:view + billing:manage onto ${ownerRoles.length} Owner role(s).`);

  const adminRoles = await db.query.roles.findMany({
    where: and(eq(roles.name, 'Admin'), eq(roles.isSystem, true), eq(roles.isDeleted, false)),
  });
  for (const role of adminRoles) {
    await permissionRepo.assignToRole(role.id, billingView.id);
  }
  console.log(`Backfilled billing:view onto ${adminRoles.length} Admin role(s).`);

  await client.end();
}

main().catch((err) => {
  console.error('Billing permissions backfill failed:', err);
  process.exit(1);
});
