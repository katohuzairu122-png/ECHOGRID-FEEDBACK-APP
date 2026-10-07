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
