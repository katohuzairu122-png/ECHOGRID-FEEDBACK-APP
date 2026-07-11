import { eq, and, sql } from 'drizzle-orm';
import { loyaltyAccounts } from '../db/schema';
import type { Customer } from './customer.repository';
import { BaseRepository } from './base.repository';

export type LoyaltyAccount = typeof loyaltyAccounts.$inferSelect;
export type NewLoyaltyAccount = typeof loyaltyAccounts.$inferInsert;
export type LoyaltyAccountWithCustomer = LoyaltyAccount & {
  customer: Pick<Customer, 'id' | 'phone' | 'fullName'>;
};

export class LoyaltyAccountRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<LoyaltyAccount | undefined> {
    return this.db.query.loyaltyAccounts.findFirst({
      where: and(
        eq(loyaltyAccounts.id, id),
        eq(loyaltyAccounts.businessId, businessId),
        eq(loyaltyAccounts.isDeleted, false),
      ),
    });
  }

  async findByCustomerAndBusiness(
    customerId: string,
    businessId: string,
  ): Promise<LoyaltyAccount | undefined> {
    return this.db.query.loyaltyAccounts.findFirst({
      where: and(
        eq(loyaltyAccounts.customerId, customerId),
        eq(loyaltyAccounts.businessId, businessId),
        eq(loyaltyAccounts.isDeleted, false),
      ),
    });
  }

  /** All of a customer's memberships across every business -- the customer
   * app's "my loyalty cards" list. No businessId scoping here on purpose:
   * this is the customer's own view of their own global identity's
   * memberships, not a tenant-boundary query. */
  async listForCustomer(customerId: string): Promise<LoyaltyAccount[]> {
    return this.db.query.loyaltyAccounts.findMany({
      where: and(eq(loyaltyAccounts.customerId, customerId), eq(loyaltyAccounts.isDeleted, false)),
    });
  }

  /** Joins the customer's phone/name in -- the staff accounts list needs a
   * human-identifiable row (LoyaltyAccountDto alone is just a UUID pointing
   * at a customer). Safe to widen this one method's return shape since its
   * only caller (LoyaltyAccountService.listForBusiness -> the staff GET
   * /loyalty/accounts route) already wants this; every other call site in
   * this file stays on the plain LoyaltyAccount shape. */
  async listForBusiness(
    businessId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LoyaltyAccountWithCustomer[]> {
    return this.db.query.loyaltyAccounts.findMany({
      where: and(eq(loyaltyAccounts.businessId, businessId), eq(loyaltyAccounts.isDeleted, false)),
      limit: options.limit,
      offset: options.offset,
      orderBy: (a, { desc }) => [desc(a.lastVisitAt)],
      with: { customer: { columns: { id: true, phone: true, fullName: true } } },
    });
  }

  async create(input: NewLoyaltyAccount): Promise<LoyaltyAccount> {
    const [row] = await this.db.insert(loyaltyAccounts).values(input).returning();
    return row;
  }

  /**
   * Atomic delta application via sql`` expressions, not read-then-write --
   * two concurrent earning events for the same account (e.g. a check-in and
   * a staff-recorded purchase landing at the same moment) must not lose one
   * update to the other. `pointsDelta` can be negative (redemption).
   * `recordVisit` additionally bumps visit_count/last_visit_at -- only true
   * for 'checkin' transactions, not purchases/redemptions/bonuses.
   */
  async applyPointsDelta(
    id: string,
    pointsDelta: number,
    options: { recordVisit?: boolean; tierId?: string | null } = {},
  ): Promise<LoyaltyAccount> {
    const [row] = await this.db
      .update(loyaltyAccounts)
      .set({
        points: sql`${loyaltyAccounts.points} + ${pointsDelta}`,
        ...(options.recordVisit
          ? { visitCount: sql`${loyaltyAccounts.visitCount} + 1`, lastVisitAt: new Date() }
          : {}),
        ...(options.tierId !== undefined ? { tierId: options.tierId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(loyaltyAccounts.id, id))
      .returning();
    return row;
  }

  /** Standalone tier reassignment, split from applyPointsDelta because tier
   * eligibility is computed by the service AFTER seeing the post-delta point
   * total -- two sequential small updates, not one, since the new balance
   * isn't known until the first update returns. */
  async updateTier(id: string, tierId: string | null): Promise<LoyaltyAccount> {
    const [row] = await this.db
      .update(loyaltyAccounts)
      .set({ tierId, updatedAt: new Date() })
      .where(eq(loyaltyAccounts.id, id))
      .returning();
    return row;
  }
}
