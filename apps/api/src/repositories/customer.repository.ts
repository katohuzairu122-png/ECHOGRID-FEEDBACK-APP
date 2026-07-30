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
}
