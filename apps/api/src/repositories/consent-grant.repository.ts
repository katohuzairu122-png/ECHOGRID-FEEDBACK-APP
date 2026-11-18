import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { consentGrants, type ConsentPurpose } from '../db/schema';
import { BaseRepository } from './base.repository';
import { AppError } from '../lib/errors';

export type ConsentGrant = typeof consentGrants.$inferSelect;
export type NewConsentGrant = typeof consentGrants.$inferInsert;

/**
 * DEV-72 — an idempotency key identifies one specific consent authority.
 * A uniqueness collision must never return a grant belonging to another
 * customer, business, purpose, resource, scope or consent version.
 */
export function assertConsentIdempotencyMatch(
  existing: Pick<ConsentGrant,
    'customerId' | 'businessId' | 'purpose' | 'resourceType' | 'resourceId' |
    'scope' | 'consentVersion'>,
  attempted: Pick<NewConsentGrant, 'customerId' | 'businessId' | 'purpose' |
    'resourceType' | 'resourceId' | 'scope' | 'consentVersion'>,
): void {
  if (
    existing.customerId !== attempted.customerId ||
    existing.businessId !== (attempted.businessId ?? null) ||
    existing.purpose !== attempted.purpose ||
    existing.resourceType !== (attempted.resourceType ?? null) ||
    existing.resourceId !== (attempted.resourceId ?? null) ||
    existing.scope !== (attempted.scope ?? null) ||
    existing.consentVersion !== (attempted.consentVersion ?? 'v1')
  ) {
    throw new AppError('Consent idempotency key is already in use.', 409, 'CONSENT_IDEMPOTENCY_CONFLICT');
  }
}

export class ConsentGrantRepository extends BaseRepository {
  async create(input: NewConsentGrant): Promise<ConsentGrant> {
    if (input.idempotencyKey) {
      const [inserted] = await this.db
        .insert(consentGrants)
        .values(input)
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted;

      const existing = await this.db.query.consentGrants.findFirst({
        where: eq(consentGrants.idempotencyKey, input.idempotencyKey),
      });
      if (existing) {
        assertConsentIdempotencyMatch(existing, input);
        return existing;
      }
      throw new Error('Consent idempotency conflict did not resolve to an existing grant.');
    }

    const [row] = await this.db.insert(consentGrants).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async listForCustomer(customerId: string, options: { limit: number; offset: number } = { limit: 100, offset: 0 }): Promise<ConsentGrant[]> {
    return this.db.query.consentGrants.findMany({
      where: eq(consentGrants.customerId, customerId),
      orderBy: [desc(consentGrants.grantedAt), desc(consentGrants.id)],
      limit: options.limit,
      offset: options.offset,
    });
  }

  async findLatestForResource(
    customerId: string,
    businessId: string | null,
    purpose: ConsentPurpose,
    resourceType: string,
    resourceId: string,
  ): Promise<ConsentGrant | undefined> {
    return this.db.query.consentGrants.findFirst({
      where: and(
        eq(consentGrants.customerId, customerId),
        businessId === null ? isNull(consentGrants.businessId) : eq(consentGrants.businessId, businessId),
        eq(consentGrants.purpose, purpose),
        eq(consentGrants.resourceType, resourceType),
        eq(consentGrants.resourceId, resourceId),
      ),
      orderBy: (row, { desc }) => [desc(row.grantedAt), desc(row.createdAt)],
    });
  }

  async findActiveForResource(
    customerId: string,
    businessId: string | null,
    purpose: ConsentPurpose,
    resourceType: string,
    resourceId: string,
  ): Promise<ConsentGrant | undefined> {
    const now = new Date();
    return this.db.query.consentGrants.findFirst({
      where: and(
        eq(consentGrants.customerId, customerId),
        businessId === null ? isNull(consentGrants.businessId) : eq(consentGrants.businessId, businessId),
        eq(consentGrants.purpose, purpose),
        eq(consentGrants.resourceType, resourceType),
        eq(consentGrants.resourceId, resourceId),
        eq(consentGrants.status, 'active'),
        or(isNull(consentGrants.expiresAt), gt(consentGrants.expiresAt, now)),
      ),
    });
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

  /**
   * The customer's own grant in ANY state (active, revoked, expired), or
   * `undefined` when it does not exist or belongs to someone else. Lets a
   * caller learn what revoking it would affect (purpose, business) before it
   * takes the locks that make the revoke safe.
   */
  async findOwned(id: string, customerId: string): Promise<ConsentGrant | undefined> {
    return this.db.query.consentGrants.findFirst({
      where: and(eq(consentGrants.id, id), eq(consentGrants.customerId, customerId)),
    });
  }

  async revoke(id: string, customerId: string): Promise<boolean> {
    return (await this.revokeReturning(id, customerId)) !== undefined;
  }

  /**
   * DEV-70: revokes an ACTIVE, unexpired, customer-owned grant and returns the
   * revoked row, or `undefined` when nothing transitioned (missing, another
   * customer's, expired or already revoked). An unmatched UPDATE is never
   * treated as success. The row tells the caller which purpose and business
   * were withdrawn.
   */
  async revokeReturning(id: string, customerId: string): Promise<ConsentGrant | undefined> {
    const [updated] = await this.db
      .update(consentGrants)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(
        eq(consentGrants.id, id),
        eq(consentGrants.customerId, customerId),
        eq(consentGrants.status, 'active'),
        or(isNull(consentGrants.expiresAt), gt(consentGrants.expiresAt, new Date())),
      ))
      .returning();
    return updated;
  }

  /**
   * Revokes every grant of one purpose that is still marked active for one
   * customer and business (expired ones included, so nothing stays "active" in
   * the table) and returns how many changed. Used when a membership ends: the
   * consent that created it goes with it.
   */
  async revokeActiveForPurpose(customerId: string, businessId: string, purpose: ConsentPurpose): Promise<number> {
    const revoked = await this.db
      .update(consentGrants)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(
        eq(consentGrants.customerId, customerId),
        eq(consentGrants.businessId, businessId),
        eq(consentGrants.purpose, purpose),
        eq(consentGrants.status, 'active'),
      ))
      .returning({ id: consentGrants.id });
    return revoked.length;
  }
}
