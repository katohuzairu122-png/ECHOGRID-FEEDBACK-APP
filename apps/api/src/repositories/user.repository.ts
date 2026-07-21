import { eq, and } from 'drizzle-orm';
import { users } from '../db/schema';
import { BaseRepository } from './base.repository';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * Returns full rows, including passwordHash. Callers (auth logic in Block 5,
 * route handlers in Block 7) are responsible for stripping sensitive fields
 * before a user object ever reaches an API response -- this repository does
 * not assume how its callers will use the data.
 */
export class UserRepository extends BaseRepository {
  async findById(id: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.id, id), eq(users.isDeleted, false)),
    });
  }

  async findByEmail(email: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.isDeleted, false)),
    });
  }

  async create(input: NewUser): Promise<User> {
    const [row] = await this.db.insert(users).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /** Email changes go through a dedicated verification flow, not a generic
   * patch -- excluded here on purpose. */
  async update(
    id: string,
    patch: Partial<Omit<NewUser, 'id' | 'email'>>,
    updatedBy: string,
  ): Promise<User | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.isDeleted, false)))
      .returning();
    return row;
  }

  async touchLastLogin(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    await this.db
      .update(users)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(eq(users.id, id));
  }
}
