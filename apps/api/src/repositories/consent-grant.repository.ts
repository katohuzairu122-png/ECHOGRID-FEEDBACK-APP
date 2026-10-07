import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { consentGrants, type ConsentPurpose } from '../db/schema';
import { BaseRepository } from './base.repository';

export type ConsentGrant = typeof consentGrants.$inferSelect;
export type NewConsentGrant = typeof consentGrants.$inferInsert;

export class ConsentGrantRepository extends BaseRepository {
  async create(input: NewConsentGrant): Promise<ConsentGrant> {
    if (input.idempotencyKey) {
      const existing = await this.db.query.consentGrants.findFirst({
        where: eq(consentGrants.idempotencyKey, input.idempotencyKey),
      });
      if (existing) return existing;
    }
    const [row] = await this.db.insert(consentGrants).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findActive(customerId: string, businessId: string, purpose: ConsentPurpose): Promise<ConsentGrant | undefined> {
    const now = new Date();
    return this.db.query.consentGrants.findFirst({
      where: and(
        eq(consentGrants.customerId, customerId),
        eq(consentGrants.businessId, businessId),
        eq(consentGrants.purpose, purpose),
        eq(consentGrants.status, 'active'),
        or(isNull(consentGrants.expiresAt), gt(consentGrants.expiresAt, now)),
      ),
    });
  }

  async revoke(id: string, customerId: string): Promise<void> {
    await this.db
      .update(consentGrants)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(consentGrants.id, id), eq(consentGrants.customerId, customerId), eq(consentGrants.status, 'active')));
  }
}
