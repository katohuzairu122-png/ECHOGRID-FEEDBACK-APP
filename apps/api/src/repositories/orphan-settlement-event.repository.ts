import { desc, eq } from 'drizzle-orm';
import { orphanSettlementEvents } from '../db/schema';
import { BaseRepository } from './base.repository';

export type OrphanSettlementEvent = typeof orphanSettlementEvents.$inferSelect;
export type NewOrphanSettlementEvent = typeof orphanSettlementEvents.$inferInsert;

export class OrphanSettlementEventRepository extends BaseRepository {
  async findById(id: string): Promise<OrphanSettlementEvent | undefined> {
    return this.db.query.orphanSettlementEvents.findFirst({
      where: eq(orphanSettlementEvents.id, id),
    });
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<OrphanSettlementEvent | undefined> {
    return this.db.query.orphanSettlementEvents.findFirst({
      where: eq(orphanSettlementEvents.idempotencyKey, idempotencyKey),
    });
  }

  async appendIdempotent(
    input: NewOrphanSettlementEvent,
  ): Promise<{ event: OrphanSettlementEvent; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(orphanSettlementEvents)
      .values(input)
      .onConflictDoNothing({ target: orphanSettlementEvents.idempotencyKey })
      .returning();

    if (inserted) return { event: inserted, inserted: true };

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new Error(
        'Orphan settlement event conflict did not resolve to an existing row',
      );
    }
    return { event: existing, inserted: false };
  }

  async listForClaim(
    claimId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<OrphanSettlementEvent[]> {
    return this.db.query.orphanSettlementEvents.findMany({
      where: eq(orphanSettlementEvents.claimId, claimId),
      orderBy: [desc(orphanSettlementEvents.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }

  async listForSettlement(
    settlementId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<OrphanSettlementEvent[]> {
    return this.db.query.orphanSettlementEvents.findMany({
      where: eq(orphanSettlementEvents.settlementId, settlementId),
      orderBy: [desc(orphanSettlementEvents.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }

  // No update/delete methods by design: settlement events are append-only.
}
