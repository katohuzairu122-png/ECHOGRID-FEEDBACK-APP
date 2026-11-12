import { eq, and } from 'drizzle-orm';
import { customers } from '../db/schema';
import { BaseRepository } from './base.repository';

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

/**
 * No businessId on any method here -- customers are a GLOBAL identity (see
 * schema comment on customers.ts), unlike every business-owned repository
 * elsewhere in this codebase. Tenant scoping for loyalty data lives on
 * LoyaltyAccountRepository instead.
 */
export class CustomerRepository extends BaseRepository {
  async findById(id: string): Promise<Customer | undefined> {
    return this.db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.isDeleted, false)),
    });
  }

  async findByPhone(phone: string): Promise<Customer | undefined> {
    return this.db.query.customers.findFirst({
      where: and(eq(customers.phone, phone), eq(customers.isDeleted, false)),
    });
  }

  async create(input: NewCustomer): Promise<Customer> {
    const [row] = await this.db.insert(customers).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Find-or-create keyed on the phone, safe under concurrency. Two simultaneous
   * first verifications of one new phone previously raced (read, then plain
   * insert) and the loser hit the unique constraint. Here the insert is
   * `ON CONFLICT DO NOTHING`, then the winner's row is re-read.
   *
   * A conflict with NO visible row means the phone is held by a soft-deleted
   * customer (the unique constraint covers deleted rows, `findByPhone` does not).
   * That is returned as `customer: undefined` so the caller can refuse cleanly
   * instead of crashing. An existing but unverified customer is marked verified,
   * because the caller has just proven the phone.
   */
  async createIfAbsent(input: {
    phone: string;
    phoneVerifiedAt: Date;
  }): Promise<{ customer: Customer | undefined; created: boolean }> {
    const inserted = await this.db
      .insert(customers)
      .values({ phone: input.phone, phoneVerifiedAt: input.phoneVerifiedAt })
      .onConflictDoNothing({ target: customers.phone })
      .returning();
    if (inserted[0]) return { customer: inserted[0], created: true };

    const existing = await this.findByPhone(input.phone);
    if (!existing) return { customer: undefined, created: false };
    if (!existing.phoneVerifiedAt) {
      return { customer: (await this.markPhoneVerified(existing.id)) ?? existing, created: false };
    }
    return { customer: existing, created: false };
  }

  async markPhoneVerified(id: string): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ phoneVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return row;
  }

  async updateProfile(
    id: string,
    patch: Partial<Pick<NewCustomer, 'fullName' | 'email' | 'birthday'>>,
  ): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return row;
  }

  async setPreferredLocale(id: string, locale: string): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ preferredLocale: locale, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning();
    return row;
  }
}
