import { eq, and } from 'drizzle-orm';
import { qrCodes } from '../db/schema';
import { BaseRepository } from './base.repository';

export type QrCode = typeof qrCodes.$inferSelect;
export type NewQrCode = typeof qrCodes.$inferInsert;

export class QrCodeRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<QrCode | undefined> {
    return this.db.query.qrCodes.findFirst({
      where: and(
        eq(qrCodes.id, id),
        eq(qrCodes.businessId, businessId),
        eq(qrCodes.isDeleted, false),
      ),
    });
  }

  async findActiveForBranch(branchId: string, businessId: string): Promise<QrCode | undefined> {
    return this.db.query.qrCodes.findFirst({
      where: and(
        eq(qrCodes.branchId, branchId),
        eq(qrCodes.businessId, businessId),
        eq(qrCodes.status, 'active'),
        eq(qrCodes.isDeleted, false),
      ),
    });
  }

  /**
   * The ONE method on this repository that deliberately does NOT take a
   * businessId -- unlike every other business-owned lookup in this schema.
   * This is the public landing page's entry point: QrCodeService.resolveToken
   * (Continuing Development Block 3.2) calls this with the qrCodeId it just
   * cryptographically verified out of a signed token's `sub` claim
   * (qr/qr-token.ts), specifically to find out which business/branch the
   * code belongs to -- requiring businessId as an input here would be
   * circular. Replaces the pre-3.2 findActiveByToken (opaque-string lookup);
   * same shape and the same enumeration-resistance principle -- a revoked
   * or unknown id is indistinguishable to the caller -- just keyed by id
   * now that the id itself only ever reaches here wrapped in a verified
   * signature.
   */
  async findActiveById(id: string): Promise<QrCode | undefined> {
    return this.db.query.qrCodes.findFirst({
      where: and(eq(qrCodes.id, id), eq(qrCodes.status, 'active'), eq(qrCodes.isDeleted, false)),
    });
  }

  async create(input: NewQrCode): Promise<QrCode> {
    const [row] = await this.db.insert(qrCodes).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Sets status='revoked' only -- does NOT soft-delete. A revoked code stays
   * fully queryable (audit/history: "when did this branch last regenerate
   * its code"), it just fails findActiveForBranch/findActiveById from
   * this point on. isDeleted stays reserved for true removal.
   */
  async revoke(id: string, businessId: string, revokedBy: string): Promise<void> {
    await this.db
      .update(qrCodes)
      .set({ status: 'revoked', updatedBy: revokedBy, updatedAt: new Date() })
      .where(and(eq(qrCodes.id, id), eq(qrCodes.businessId, businessId)));
  }
}
