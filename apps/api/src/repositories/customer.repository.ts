import { eq, and, sql, desc, lte } from 'drizzle-orm';
import { customers, customerSanctions, businessCustomerMemberships } from '../db/schema';
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
    const row = await this.db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.isDeleted, false)),
    });
    return row ? this.liftIfSuspensionEnded(row) : row;
  }

  async findByPhone(phone: string): Promise<Customer | undefined> {
    const row = await this.db.query.customers.findFirst({
      where: and(eq(customers.phone, phone), eq(customers.isDeleted, false)),
    });
    return row ? this.liftIfSuspensionEnded(row) : row;
  }

  /**
   * A timed suspension ends by itself. Every access check in the API compares
   * `status === 'active'`, so rather than touching each of them, the two
   * lookups they all go through reinstate a customer whose suspension period
   * has passed. Only suspended rows with an end time ever write; the common
   * active path costs nothing extra. The reinstatement is recorded in the
   * sanctions history (no actor) so it is visible.
   */
  private async liftIfSuspensionEnded(row: Customer, now: Date = new Date()): Promise<Customer> {
    if (row.status !== 'suspended' || !row.suspendedUntil || row.suspendedUntil.getTime() > now.getTime()) {
      return row;
    }
    const [lifted] = await this.db
      .update(customers)
      .set({ status: 'active', suspendedUntil: null })
      .where(
        and(
          eq(customers.id, row.id),
          eq(customers.status, 'suspended'),
          lte(customers.suspendedUntil, now),
        ),
      )
      .returning();
    if (lifted) {
      await this.db.insert(customerSanctions).values({
        customerId: row.id,
        action: 'lift',
        reason: 'Suspension period ended.',
      });
      return lifted;
    }
    return (await this.db.query.customers.findFirst({ where: eq(customers.id, row.id) })) ?? row;
  }

  /**
   * Platform moderation list. Exact lookup only: a customer id or a full
   * phone number typed by the admin; there is no free-text browse of names or
   * contact details. Returns a membership count per row, never loyalty data.
   */
  async listForPlatform(input: {
    id?: string | undefined;
    phone?: string | undefined;
    status?: 'active' | 'suspended' | 'banned' | undefined;
    withoutBusiness?: boolean | undefined;
    limit: number;
    offset: number;
  }): Promise<Array<Customer & { businessCount: number }>> {
    const businessCount = sql<number>`(SELECT count(*)::int FROM ${businessCustomerMemberships} m WHERE m.customer_id = ${customers.id} AND m.is_deleted = false)`;
    const conditions = [eq(customers.isDeleted, false)];
    if (input.id) conditions.push(eq(customers.id, input.id));
    if (input.phone) conditions.push(eq(customers.phone, input.phone));
    if (input.status) conditions.push(eq(customers.status, input.status));
    if (input.withoutBusiness) conditions.push(sql`${businessCount} = 0`);
    const rows = await this.db
      .select({ customer: customers, businessCount })
      .from(customers)
      .where(and(...conditions))
      .orderBy(desc(customers.createdAt))
      .limit(input.limit)
      .offset(input.offset);
    return rows.map((r) => ({ ...r.customer, businessCount: r.businessCount }));
  }

  async countBusinesses(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(businessCustomerMemberships)
      .where(and(eq(businessCustomerMemberships.customerId, customerId), eq(businessCustomerMemberships.isDeleted, false)));
    return row?.n ?? 0;
  }

  async setModeration(
    id: string,
    patch: { status: 'active' | 'suspended' | 'banned'; suspendedUntil: Date | null },
  ): Promise<Customer | undefined> {
    const [row] = await this.db
      .update(customers)
      .set({ status: patch.status, suspendedUntil: patch.suspendedUntil })
      .where(and(eq(customers.id, id), eq(customers.isDeleted, false)))
      .returning();
    return row;
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
