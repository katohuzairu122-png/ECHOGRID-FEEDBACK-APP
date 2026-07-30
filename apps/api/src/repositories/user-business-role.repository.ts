import { eq, and, isNull } from 'drizzle-orm';
import { userBusinessRoles } from '../db/schema';
import { BaseRepository } from './base.repository';

export type UserBusinessRole = typeof userBusinessRoles.$inferSelect;
export type NewUserBusinessRole = typeof userBusinessRoles.$inferInsert;

/** Shape returned by listForBusinessWithDetails -- a grant hydrated with
 * its user's and role's display fields, for UI that needs to show a name/
 * email/role rather than three raw foreign keys. */
export type PlatformTeamMember = {
  id: string;
  userId: string;
  userEmail: string;
  userFullName: string;
  roleId: string;
  roleName: string;
  branchId: string | null;
};

/**
 * Grants/revokes are append-and-soft-delete, never updated in place, so "who
 * had access when" stays reconstructable. A NULL branchId on a row means a
 * business-wide grant (see schema comment).
 */
export class UserBusinessRoleRepository extends BaseRepository {
  async grant(input: NewUserBusinessRole): Promise<UserBusinessRole> {
    const [row] = await this.db.insert(userBusinessRoles).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async revoke(id: string, deletedBy: string): Promise<void> {
    await this.db
      .update(userBusinessRoles)
      .set({ deletedAt: new Date(), deletedBy })
      .where(eq(userBusinessRoles.id, id));
  }

  /** Active (non-revoked) grants for a user, across all businesses -- used to
   * build a session's business/branch/role context after login (Block 5). */
  async listForUser(userId: string): Promise<UserBusinessRole[]> {
    return this.db.query.userBusinessRoles.findMany({
      where: and(eq(userBusinessRoles.userId, userId), isNull(userBusinessRoles.deletedAt)),
    });
  }

  /** Active grants for a user at one specific business -- used by
   * resolveTenantContext to confirm membership before resolving permissions. */
  async listForUserAtBusiness(userId: string, businessId: string): Promise<UserBusinessRole[]> {
    return this.db.query.userBusinessRoles.findMany({
      where: and(
        eq(userBusinessRoles.userId, userId),
        eq(userBusinessRoles.businessId, businessId),
        isNull(userBusinessRoles.deletedAt),
      ),
    });
  }

  /** Active grants at a business, optionally narrowed to one branch --
   * "who has access here," for team-management UI. */
  async listForBusiness(
    businessId: string,
    options: { branchId?: string } = {},
  ): Promise<UserBusinessRole[]> {
    return this.db.query.userBusinessRoles.findMany({
      where: and(
        eq(userBusinessRoles.businessId, businessId),
        isNull(userBusinessRoles.deletedAt),
        options.branchId ? eq(userBusinessRoles.branchId, options.branchId) : undefined,
      ),
    });
  }

  /**
   * Same active-grants query as listForBusiness, hydrated with the user's
   * and role's display fields via the relations in db/schema/relations.ts.
   * Separate method rather than an options flag on listForBusiness -- the
   * plain version's callers (resolveTenantContext's permission resolution
   * path) run on every permission check in the app and have no use for the
   * join cost; this one backs the Platform Admin Console's team list
   * (Block 4), a low-frequency, admin-facing read where the extra cost is
   * irrelevant and the join saves the caller N+1 lookups.
   */
  async listForBusinessWithDetails(
    businessId: string,
    options: { branchId?: string } = {},
  ): Promise<PlatformTeamMember[]> {
    const rows = await this.db.query.userBusinessRoles.findMany({
      where: and(
        eq(userBusinessRoles.businessId, businessId),
        isNull(userBusinessRoles.deletedAt),
        options.branchId ? eq(userBusinessRoles.branchId, options.branchId) : undefined,
      ),
      with: { user: true, role: true },
    });

    return rows.map((row) => ({
      id: row.id,
      userId: row.user.id,
      userEmail: row.user.email,
      userFullName: row.user.fullName,
      roleId: row.role.id,
      roleName: row.role.name,
      branchId: row.branchId,
    }));
  }
}
