import { and, eq } from 'drizzle-orm';
import { businessCustomerMemberships } from '../db/schema';
import { BaseRepository } from './base.repository';

export type BusinessCustomerMembership = typeof businessCustomerMemberships.$inferSelect;
export type NewBusinessCustomerMembership = typeof businessCustomerMemberships.$inferInsert;

export class CustomerMembershipRepository extends BaseRepository {
  async findByCustomerAndBusiness(customerId: string, businessId: string): Promise<BusinessCustomerMembership | undefined> {
    return this.db.query.businessCustomerMemberships.findFirst({
      where: and(
        eq(businessCustomerMemberships.customerId, customerId),
        eq(businessCustomerMemberships.businessId, businessId),
        eq(businessCustomerMemberships.isDeleted, false),
      ),
    });
  }

  /**
   * Same lookup as `findByCustomerAndBusiness`, but takes a row-level SHARE lock
   * that is held until the surrounding transaction ends. Spending and earning
   * paths read the membership through this so that a concurrent leave or
   * consent withdrawal (which UPDATEs the row) is strictly ordered against
   * them: a spend that read "active" finishes before the leave commits, and one
   * that starts after it sees "left". SHARE locks do not block each other, so
   * concurrent spends stay concurrent.
   *
   * Only meaningful inside a transaction. Uses the select builder because the
   * relational query API does not expose FOR SHARE (see
   * `LoyaltyRewardRepository.lockForUpdate` for the same reasoning).
   */
  async findByCustomerAndBusinessForShare(
    customerId: string,
    businessId: string,
  ): Promise<BusinessCustomerMembership | undefined> {
    const [row] = await this.db
      .select()
      .from(businessCustomerMemberships)
      .where(
        and(
          eq(businessCustomerMemberships.customerId, customerId),
          eq(businessCustomerMemberships.businessId, businessId),
          eq(businessCustomerMemberships.isDeleted, false),
        ),
      )
      .for('share');
    return row;
  }

  async findActive(customerId: string, businessId: string): Promise<BusinessCustomerMembership | undefined> {
    return this.db.query.businessCustomerMemberships.findFirst({
      where: and(
        eq(businessCustomerMemberships.customerId, customerId),
        eq(businessCustomerMemberships.businessId, businessId),
        eq(businessCustomerMemberships.status, 'active'),
        eq(businessCustomerMemberships.isDeleted, false),
      ),
    });
  }

  async listForCustomer(customerId: string): Promise<BusinessCustomerMembership[]> {
    return this.db.query.businessCustomerMemberships.findMany({
      where: and(eq(businessCustomerMemberships.customerId, customerId), eq(businessCustomerMemberships.isDeleted, false)),
    });
  }

  async listForBusiness(businessId: string): Promise<BusinessCustomerMembership[]> {
    return this.db.query.businessCustomerMemberships.findMany({
      where: and(eq(businessCustomerMemberships.businessId, businessId), eq(businessCustomerMemberships.isDeleted, false)),
    });
  }

  async create(input: NewBusinessCustomerMembership): Promise<BusinessCustomerMembership> {
    const [row] = await this.db.insert(businessCustomerMemberships).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Active -> left. Conditional on the row still being active, so it returns
   * `undefined` (and changes nothing) when the membership was already left,
   * suspended or closed; the caller decides what that means. The loyalty
   * account and its points are deliberately untouched: leaving stops earning
   * and spending but keeps the balance, which comes back on re-join.
   */
  async markLeft(id: string): Promise<BusinessCustomerMembership | undefined> {
    const now = new Date();
    const [row] = await this.db
      .update(businessCustomerMemberships)
      .set({ status: 'left', leftAt: now, updatedAt: now })
      .where(
        and(
          eq(businessCustomerMemberships.id, id),
          eq(businessCustomerMemberships.status, 'active'),
          eq(businessCustomerMemberships.isDeleted, false),
        ),
      )
      .returning();
    return row;
  }

  async reactivate(id: string, onboardingSource?: string, onboardingReference?: string): Promise<BusinessCustomerMembership> {
    const [row] = await this.db
      .update(businessCustomerMemberships)
      .set({
        status: 'active',
        joinedAt: new Date(),
        leftAt: null,
        suspendedAt: null,
        closedAt: null,
        ...(onboardingSource !== undefined ? { onboardingSource } : {}),
        ...(onboardingReference !== undefined ? { onboardingReference } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(businessCustomerMemberships.id, id), eq(businessCustomerMemberships.isDeleted, false)))
      .returning();
    if (!row) throw new Error('Membership not found');
    return row;
  }
}
