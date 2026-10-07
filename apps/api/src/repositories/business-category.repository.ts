import { and, eq } from 'drizzle-orm';
import { businessCategories } from '../db/schema';
import { BaseRepository } from './base.repository';

export type BusinessCategory = typeof businessCategories.$inferSelect;

export class BusinessCategoryRepository extends BaseRepository {
  async findByKey(key: string, activeOnly = true): Promise<BusinessCategory | undefined> {
    return this.db.query.businessCategories.findFirst({
      where: and(
        eq(businessCategories.key, key),
        activeOnly ? eq(businessCategories.isActive, true) : undefined,
      ),
    });
  }

  async findById(id: string): Promise<BusinessCategory | undefined> {
    return this.db.query.businessCategories.findFirst({
      where: eq(businessCategories.id, id),
    });
  }

  async listActive(): Promise<BusinessCategory[]> {
    return this.db.query.businessCategories.findMany({
      where: eq(businessCategories.isActive, true),
      orderBy: (row, { asc }) => [asc(row.sortOrder), asc(row.name)],
    });
  }
}
