import { and, desc, eq } from 'drizzle-orm';
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

  async lockForUpdate(id: string): Promise<OrphanSettlement | undefined> {
    const [row] = await this.db
      .select()
      .from(orphanSettlements)
      .where(eq(orphanSettlements.id, id))
      .for('update');
    return row;
  }

  async reserveProposed(
    id: string,
    input: {
      receivingBranchId?: string | undefined;
      acceptedByUserId: string;
      acceptedAt: Date;
      fulfillmentPolicyVersion: string;
      fulfillmentSnapshot: Record<string, unknown>;
      fulfillmentReference?: string | undefined;
    },
  ): Promise<OrphanSettlement | undefined> {
    const [row] = await this.db
      .update(orphanSettlements)
      .set({
        status: 'reserved',
        receivingBranchId: input.receivingBranchId ?? null,
        acceptedByUserId: input.acceptedByUserId,
        acceptedAt: input.acceptedAt,
        fulfillmentPolicyVersion: input.fulfillmentPolicyVersion,
        fulfillmentSnapshot: input.fulfillmentSnapshot,
        fulfillmentReference: input.fulfillmentReference ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orphanSettlements.id, id),
          eq(orphanSettlements.status, 'proposed'),
        ),
      )
      .returning();
    return row;
  }

  async authorizeCompletionReserved(
    id: string,
    input: {
      completionAuthorizationId: string;
      completionAuthorizedAt: Date;
    },
  ): Promise<OrphanSettlement | undefined> {
    const [row] = await this.db
      .update(orphanSettlements)
      .set({
        status: 'completion_authorized',
        completionAuthorizationId: input.completionAuthorizationId,
        completionAuthorizedAt: input.completionAuthorizedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orphanSettlements.id, id),
          eq(orphanSettlements.status, 'reserved'),
        ),
      )
      .returning();
    return row;
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
