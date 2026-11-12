import 'dotenv/config';
import { Client } from 'pg';
import { and, eq, inArray } from 'drizzle-orm';
import { buildDb } from '../client';
import { auditLog, permissions, rolePermissions, roles } from '../schema';
import {
  NEW_LOYALTY_PERMISSIONS,
  planAdditive,
  planReduce,
  type PlanAction,
  type RoleSnapshot,
} from '../../rbac/loyalty-permissions';

/**
 * D-C1 role-grant reconciliation. NOT run automatically and NOT a drizzle migration: it changes data only
 * (role_permissions rows), never schema, following the existing seed/backfill convention.
 *
 *   --phase=additive  Safe BEFORE the D-C1 API is deployed. Only adds the new permissions to roles that held
 *                     the authority they replace. Never removes anything.
 *   --phase=reduce    Run only AFTER the D-C1 API is deployed. Removes the legacy exposure (loyalty:view,
 *                     loyalty:manage, feedback:view, messages:view, messages:send) from system Staff roles that
 *                     are provably unmodified defaults AND already hold loyalty:serve. Custom, renamed and
 *                     administrative roles are never changed; any Staff-named role with extra grants is listed
 *                     for an owner decision.
 *
 * Default is a DRY RUN that prints the plan and changes nothing. To apply, pass --apply AND set
 * RBAC_RECONCILE_CONFIRM to the phase name. Every changed role writes an audit_log row. Idempotent: running a
 * phase twice changes nothing the second time. Requires the permissions catalog to be seeded first
 * (pnpm db:seed). Needs its own owner authorization per environment; the first run should be a dry run
 * whose output the owner reviews.
 *
 * Rollback / forward recovery: additive grants are harmless to roll back by deleting the three new keys from
 * the affected roles; a reduce can be reversed by re-granting the five legacy keys to the listed role ids
 * (the audit rows record every role id and key). Take a Neon restore point before any apply.
 */
type Phase = 'additive' | 'reduce';

function parseArgs(argv: string[]): { phase: Phase; apply: boolean } {
  const phaseArg = argv.find((a) => a.startsWith('--phase='))?.split('=')[1];
  if (phaseArg !== 'additive' && phaseArg !== 'reduce') {
    throw new Error('Pass --phase=additive or --phase=reduce.');
  }
  return { phase: phaseArg, apply: argv.includes('--apply') };
}

async function main() {
  const { phase, apply } = parseArgs(process.argv.slice(2));
  if (apply && process.env.RBAC_RECONCILE_CONFIRM !== phase) {
    throw new Error(`Refusing to apply: set RBAC_RECONCILE_CONFIRM=${phase}.`);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const db = buildDb(client);
  try {
    const catalog = await db.select({ id: permissions.id, key: permissions.key }).from(permissions);
    const idByKey = new Map(catalog.map((p) => [p.key, p.id]));
    const missing = NEW_LOYALTY_PERMISSIONS.filter((k) => !idByKey.has(k));
    if (missing.length > 0) {
      throw new Error(
        `Permission catalog is missing ${missing.join(', ')}. Run the permissions seed first.`,
      );
    }

    const rows = await db
      .select({
        roleId: roles.id,
        businessId: roles.businessId,
        name: roles.name,
        isSystem: roles.isSystem,
        key: permissions.key,
      })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(roles.isDeleted, false));
    const byRole = new Map<string, RoleSnapshot & { keys: Set<string> }>();
    for (const r of rows) {
      const snap = byRole.get(r.roleId) ?? {
        roleId: r.roleId,
        businessId: r.businessId,
        name: r.name,
        isSystem: r.isSystem,
        keys: new Set<string>(),
      };
      if (r.key) snap.keys.add(r.key);
      byRole.set(r.roleId, snap);
    }
    const snapshots = [...byRole.values()];
    const plan: PlanAction[] =
      phase === 'additive' ? planAdditive(snapshots) : planReduce(snapshots);

    const changing = plan.filter((a) => a.grant.length > 0 || a.revoke.length > 0);
    const decisions = plan.filter((a) => a.needsOwnerDecision.length > 0);
    console.log(
      JSON.stringify({
        phase,
        mode: apply ? 'APPLY' : 'DRY-RUN',
        rolesInspected: snapshots.length,
        rolesToChange: changing.length,
        rolesNeedingOwnerDecision: decisions.length,
      }),
    );
    for (const a of plan) {
      console.log(
        JSON.stringify({
          roleId: a.roleId,
          businessId: a.businessId,
          role: a.roleName,
          class: a.classification,
          grant: a.grant,
          revoke: a.revoke,
          ownerDecision: a.needsOwnerDecision,
        }),
      );
    }
    if (!apply) {
      console.log('Dry run only. Nothing was changed.');
      return;
    }

    await db.transaction(async (tx) => {
      for (const a of changing) {
        if (a.grant.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(a.grant.map((key) => ({ roleId: a.roleId, permissionId: idByKey.get(key)! })))
            .onConflictDoNothing();
        }
        if (a.revoke.length > 0) {
          await tx
            .delete(rolePermissions)
            .where(
              and(
                eq(rolePermissions.roleId, a.roleId),
                inArray(
                  rolePermissions.permissionId,
                  a.revoke.map((k) => idByKey.get(k)!).filter(Boolean),
                ),
              ),
            );
        }
        await tx.insert(auditLog).values({
          businessId: a.businessId,
          action: 'rbac.role_permissions_reconciled',
          entityType: 'role',
          entityId: a.roleId,
          metadata: {
            block: 'D-C1',
            phase,
            classification: a.classification,
            granted: a.grant,
            revoked: a.revoke,
          },
        });
      }
    });
    console.log(`Applied ${changing.length} role change(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('D-C1 reconciliation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
