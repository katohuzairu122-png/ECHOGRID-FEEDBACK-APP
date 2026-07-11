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
   * This is the public landing page's entry point: resolving FROM the token
   * is how the caller finds out which business/branch it belongs to, so
   * requiring businessId as an input would be circular. Only ever resolves
   * an ACTIVE, non-deleted code, so a revoked or unknown token is
   * indistinguishable to the caller -- same enumeration-resistance
   * principle as login's identical error for a wrong password vs. a
   * nonexistent account.
   */
  async findActiveByToken(token: string): Promise<QrCode | undefined> {
    return this.db.query.qrCodes.findFirst({
      where: and(eq(qrCodes.token, token), eq(qrCodes.status, 'active'), eq(qrCodes.isDeleted, false)),
    });
  }

  async create(input: NewQrCode): Promise<QrCode> {
    const [row] = await this.db.insert(qrCodes).values(input).returning();
    return row;
  }

  /**
   * Sets status='revoked' only -- does NOT soft-delete. A revoked code stays
   * fully queryable (audit/history: "when did this branch last regenerate
   * its code"), it just fails findActiveForBranch/findActiveByToken from
   * this point on. isDeleted stays reserved for true removal.
   */
  async revoke(id: string, businessId: string, revokedBy: string): Promise<void> {
    await this.db
      .update(qrCodes)
      .set({ status: 'revoked', updatedBy: revokedBy, updatedAt: new Date() })
      .where(and(eq(qrCodes.id, id), eq(qrCodes.businessId, businessId)));
  }
}
