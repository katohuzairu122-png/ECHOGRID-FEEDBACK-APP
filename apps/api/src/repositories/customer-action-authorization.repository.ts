import { and, eq, gt } from 'drizzle-orm';
import { customerActionAuthorizations } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CustomerActionAuthorization = typeof customerActionAuthorizations.$inferSelect;
export type NewCustomerActionAuthorization = typeof customerActionAuthorizations.$inferInsert;

export class CustomerActionAuthorizationRepository extends BaseRepository {
  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CustomerActionAuthorization | undefined> {
    return this.db.query.customerActionAuthorizations.findFirst({
      where: eq(customerActionAuthorizations.idempotencyKey, idempotencyKey),
    });
  }

  async create(input: NewCustomerActionAuthorization): Promise<CustomerActionAuthorization> {
    if (input.idempotencyKey) {
      const existing = await this.db.query.customerActionAuthorizations.findFirst({
        where: eq(customerActionAuthorizations.idempotencyKey, input.idempotencyKey),
      });
      if (existing) return existing;
    }
    const [row] = await this.db.insert(customerActionAuthorizations).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async consume(id: string, customerId: string): Promise<CustomerActionAuthorization | undefined> {
    const [row] = await this.db
      .update(customerActionAuthorizations)
      .set({ status: 'consumed', consumedAt: new Date() })
      .where(
        and(
          eq(customerActionAuthorizations.id, id),
          eq(customerActionAuthorizations.customerId, customerId),
          eq(customerActionAuthorizations.status, 'active'),
          gt(customerActionAuthorizations.expiresAt, new Date()),
        ),
      )
      .returning();
    return row;
  }

  async revoke(id: string, customerId: string): Promise<void> {
    await this.db
      .update(customerActionAuthorizations)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(customerActionAuthorizations.id, id),
          eq(customerActionAuthorizations.customerId, customerId),
          eq(customerActionAuthorizations.status, 'active'),
        ),
      );
  }
}
