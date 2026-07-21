import { eq, and, isNull, or } from 'drizzle-orm';
import { permissions, rolePermissions, roles, userBusinessRoles } from '../db/schema';
import { BaseRepository } from './base.repository';

export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;

export class PermissionRepository extends BaseRepository {
  async listAll(): Promise<Permission[]> {
    return this.db.query.permissions.findMany({
      orderBy: (p, { asc }) => [asc(p.category), asc(p.key)],
    });
  }

  async findByKey(key: string): Promise<Permission | undefined> {
    return this.db.query.permissions.findFirst({ where: eq(permissions.key, key) });
  }

  /** Seeds a permission if its key doesn't already exist -- safe to call
   * repeatedly (e.g. from the seed script) without duplicating rows. */
  async ensure(input: NewPermission): Promise<Permission> {
    const existing = await this.findByKey(input.key);
    if (existing) return existing;
    const [row] = await this.db.insert(permissions).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async assignToRole(roleId: string, permissionId: string): Promise<void> {
    await this.db.insert(rolePermissions).values({ roleId, permissionId }).onConflictDoNothing();
  }

  /**
   * Every permission key granted to a user at a business: from any
   * business-wide role, plus (if branchId is given) any role scoped to that
   * specific branch. This is the single source of truth for "what can this
   * user do here" -- the RBAC middleware goes through this, not a
   * hand-rolled join elsewhere.
   */
  async findEffectiveKeys(userId: string, businessId: string, branchId?: string): Promise<Set<string>> {
    const scopeCondition = branchId
      ? or(isNull(userBusinessRoles.branchId), eq(userBusinessRoles.branchId, branchId))
      : isNull(userBusinessRoles.branchId);

    const rows = await this.db
      .select({ key: permissions.key })
      .from(userBusinessRoles)
      .innerJoin(roles, eq(roles.id, userBusinessRoles.roleId))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(
        and(
          eq(userBusinessRoles.userId, userId),
          eq(userBusinessRoles.businessId, businessId),
          isNull(userBusinessRoles.deletedAt),
          eq(roles.isDeleted, false),
          scopeCondition,
        ),
      );

    return new Set(rows.map((r) => r.key));
  }
}
