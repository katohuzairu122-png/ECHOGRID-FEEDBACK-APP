import { eq, and, sql } from 'drizzle-orm';
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

  /** CASHIER-AUTH-02A: the managed identity named `loginUsername` INSIDE one business (the namespace), or undefined. */
  async findManagedByUsername(businessId: string, loginUsername: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.managedBusinessId, businessId), eq(users.loginUsername, loginUsername), eq(users.isDeleted, false)),
    });
  }

  /** A managed identity by id, pinned to its owning business: another business's cashier id is simply not found. */
  async findManagedById(businessId: string, id: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.id, id), eq(users.managedBusinessId, businessId), eq(users.isDeleted, false)),
    });
  }

  async listManagedForBusiness(businessId: string): Promise<User[]> {
    return this.db.query.users.findMany({
      where: and(eq(users.managedBusinessId, businessId), eq(users.isDeleted, false)),
      orderBy: (u, { asc }) => [asc(u.loginUsername)],
    });
  }

  /**
   * D-5 lockout, one atomic statement (the row lock serialises concurrent failures): failures inside a rolling window are
   * counted, the fifth locks the identity. While already locked nothing is recorded, so an attacker cannot extend a lock.
   */
  async recordFailedManagedLogin(id: string, maxFailures: number, windowMs: number, lockMs: number): Promise<void> {
    const windowSec = windowMs / 1000;
    const lockSec = lockMs / 1000;
    const stale = sql`(${users.failedLoginWindowStartedAt} IS NULL OR ${users.failedLoginWindowStartedAt} < now() - make_interval(secs => ${windowSec}))`;
    const nextCount = sql`(CASE WHEN ${stale} THEN 1 ELSE ${users.failedLoginCount} + 1 END)`;
    await this.db
      .update(users)
      .set({
        failedLoginWindowStartedAt: sql`(CASE WHEN ${stale} THEN now() ELSE ${users.failedLoginWindowStartedAt} END)`,
        failedLoginCount: sql`${nextCount}`,
        lockedUntil: sql`(CASE WHEN ${nextCount} >= ${maxFailures} THEN now() + make_interval(secs => ${lockSec}) ELSE ${users.lockedUntil} END)`,
      })
      .where(and(eq(users.id, id), sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= now())`));
  }

  async clearManagedLoginFailures(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ failedLoginCount: 0, failedLoginWindowStartedAt: null, lockedUntil: null })
      .where(eq(users.id, id));
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

  /**
   * Replaces a password only while it still matches the hash the caller
   * verified. This closes the gap between reading/verifying a credential and
   * writing its replacement when two password changes arrive concurrently.
   */
  async updatePasswordIfCurrentHash(
    id: string,
    currentPasswordHash: string,
    newPasswordHash: string,
    updatedBy: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ passwordHash: newPasswordHash, updatedBy, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, id),
          eq(users.passwordHash, currentPasswordHash),
          eq(users.isDeleted, false),
        ),
      )
      .returning({ id: users.id });
    return rows.length > 0;
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
