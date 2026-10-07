import { and, eq } from 'drizzle-orm';
import { loyaltyPurchaseEvents } from '../db/schema';
import { BaseRepository } from './base.repository';

export type LoyaltyPurchaseEvent = typeof loyaltyPurchaseEvents.$inferSelect;
export type NewLoyaltyPurchaseEvent = typeof loyaltyPurchaseEvents.$inferInsert;

export class LoyaltyPurchaseEventRepository extends BaseRepository {
  async findByIdempotencyKey(
    businessId: string,
    idempotencyKey: string,
  ): Promise<LoyaltyPurchaseEvent | undefined> {
    return this.db.query.loyaltyPurchaseEvents.findFirst({
      where: and(
        eq(loyaltyPurchaseEvents.businessId, businessId),
        eq(loyaltyPurchaseEvents.idempotencyKey, idempotencyKey),
      ),
    });
  }

  async createIdempotent(
    input: NewLoyaltyPurchaseEvent,
  ): Promise<{ event: LoyaltyPurchaseEvent; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(loyaltyPurchaseEvents)
      .values(input)
      .onConflictDoNothing({
        target: [loyaltyPurchaseEvents.businessId, loyaltyPurchaseEvents.idempotencyKey],
      })
      .returning();

    if (inserted) return { event: inserted, inserted: true };

    const existing = await this.findByIdempotencyKey(input.businessId, input.idempotencyKey);
    if (!existing) throw new Error('Purchase idempotency conflict did not resolve to an existing event.');
    return { event: existing, inserted: false };
  }
}
