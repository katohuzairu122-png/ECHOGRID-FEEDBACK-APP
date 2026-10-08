import { desc, eq } from 'drizzle-orm';
import { orphanSettlements } from '../db/schema';
import { BaseRepository } from './base.repository';

export type OrphanSettlement = typeof orphanSettlements.$inferSelect;
export type NewOrphanSettlement = typeof orphanSettlements.$inferInsert;

export class OrphanSettlementRepository extends BaseRepository {
  async findById(id: string): Promise<OrphanSettlement | undefined> {
    return this.db.query.orphanSettlements.findFirst({
      where: eq(orphanSettlements.id, id),
    });
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<OrphanSettlement | undefined> {
    return this.db.query.orphanSettlements.findFirst({
      where: eq(orphanSettlements.idempotencyKey, idempotencyKey),
    });
  }

  async createIdempotent(
    input: NewOrphanSettlement,
  ): Promise<{ settlement: OrphanSettlement; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(orphanSettlements)
      .values(input)
      .onConflictDoNothing({ target: orphanSettlements.idempotencyKey })
      .returning();

    if (inserted) return { settlement: inserted, inserted: true };

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new Error(
        'Orphan settlement conflict did not resolve to an existing row',
      );
    }
    return { settlement: existing, inserted: false };
  }

  async listForClaim(
    claimId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<OrphanSettlement[]> {
    return this.db.query.orphanSettlements.findMany({
      where: eq(orphanSettlements.claimId, claimId),
      orderBy: [desc(orphanSettlements.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }

  async listForReceivingBusiness(
    receivingBusinessId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<OrphanSettlement[]> {
    return this.db.query.orphanSettlements.findMany({
      where: eq(orphanSettlements.receivingBusinessId, receivingBusinessId),
      orderBy: [desc(orphanSettlements.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }
}
