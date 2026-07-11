import { eq, and } from 'drizzle-orm';
import { roles } from '../db/schema';
import { BaseRepository } from './base.repository';

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

/**
 * Every method requires businessId -- roles must never be looked up,
 * updated, or deleted across tenant boundaries (see schema comment on why
 * roles have no shared/global rows).
 */
export class RoleRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<Role | undefined> {
    return this.db.query.roles.findFirst({
      where: and(eq(roles.id, id), eq(roles.businessId, businessId), eq(roles.isDeleted, false)),
    });
  }

  async findByName(businessId: string, name: string): Promise<Role | undefined> {
    return this.db.query.roles.findFirst({
      where: and(
        eq(roles.businessId, businessId),
        eq(roles.name, name),
        eq(roles.isDeleted, false),
      ),
    });
  }

  async listByBusiness(businessId: string): Promise<Role[]> {
    return this.db.query.roles.findMany({
      where: and(eq(roles.businessId, businessId), eq(roles.isDeleted, false)),
      orderBy: (r, { asc }) => [asc(r.name)],
    });
  }

  async create(input: NewRole): Promise<Role> {
    const [row] = await this.db.insert(roles).values(input).returning();
    return row;
  }

  async update(
    id: string,
    businessId: string,
    patch: Partial<Omit<NewRole, 'id' | 'businessId'>>,
    updatedBy: string,
  ): Promise<Role | undefined> {
    const [row] = await this.db
      .update(roles)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(and(eq(roles.id, id), eq(roles.businessId, businessId), eq(roles.isDeleted, false)))
      .returning();
    return row;
  }

  async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
    await this.db
      .update(roles)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(and(eq(roles.id, id), eq(roles.businessId, businessId)));
  }
}
