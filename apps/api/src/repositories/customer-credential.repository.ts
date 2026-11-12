import { eq, sql } from 'drizzle-orm';
import { customerCredentials } from '../db/schema';
import { BaseRepository } from './base.repository';

/** Contains `passwordHash`. For the authentication service only; never map it into an API response or a log. */
export type CustomerCredential = typeof customerCredentials.$inferSelect;

/**
 * CUSTOMER-AUTH-01B section 5.1. One credential per customer, enforced by the
 * primary key (invariant I1). Not wired to any route yet (01D-2).
 */
export class CustomerCredentialRepository extends BaseRepository {
  async findByCustomerId(customerId: string): Promise<CustomerCredential | undefined> {
    return this.db.query.customerCredentials.findFirst({
      where: eq(customerCredentials.customerId, customerId),
    });
  }

  /**
   * Narrow legacy-token verification read. Unlike findByCustomerId, this does
   * not expose the password hash to the request authentication middleware.
   * Undefined means no credential (OTP-only cohort); a row with null cutoff
   * is distinguishable and must be treated as a fail-closed configuration gap
   * for a credentialed customer by the future verification service.
   */
  async findLegacyTokenCutoff(
    customerId: string,
  ): Promise<{ legacyTokensInvalidBefore: Date | null } | undefined> {
    const rows = await this.db
      .select({ legacyTokensInvalidBefore: customerCredentials.legacyTokensInvalidBefore })
      .from(customerCredentials)
      .where(eq(customerCredentials.customerId, customerId))
      .limit(1);
    return rows[0];
  }

  async exists(customerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ customerId: customerCredentials.customerId })
      .from(customerCredentials)
      .where(eq(customerCredentials.customerId, customerId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * First-time creation. Idempotent and race-safe: when a credential already
   * exists the insert does nothing and returns false, so two devices enrolling
   * at once produce exactly one credential and never an error (01C section 8).
   * Changing an existing password is `change`, which the caller must gate on
   * the current password or a fresh step-up.
   */
  async create(input: { customerId: string; passwordHash: string; now: Date }): Promise<boolean> {
    const rows = await this.db
      .insert(customerCredentials)
      .values({
        customerId: input.customerId,
        passwordHash: input.passwordHash,
        passwordSetAt: input.now,
        passwordChangedAt: input.now,
        // A newly enrolled password must retire previously issued legacy JWTs.
        // This is persisted with the hash in the same INSERT.
        legacyTokensInvalidBefore: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: customerCredentials.customerId })
      .returning({ customerId: customerCredentials.customerId });
    return rows.length > 0;
  }

  /** Replaces the hash of an existing credential. Returns false if the customer has none. */
  async change(input: { customerId: string; passwordHash: string; now: Date }): Promise<boolean> {
    const rows = await this.db
      .update(customerCredentials)
      .set({
        passwordHash: input.passwordHash,
        passwordChangedAt: sql`GREATEST(${customerCredentials.passwordChangedAt}, ${input.now})`,
        updatedAt: sql`GREATEST(${customerCredentials.updatedAt}, ${input.now})`,
        // Monotonic even under concurrent changes or a skewed caller clock.
        legacyTokensInvalidBefore: sql`GREATEST(${customerCredentials.legacyTokensInvalidBefore}, ${input.now})`,
      })
      .where(eq(customerCredentials.customerId, input.customerId))
      .returning({ customerId: customerCredentials.customerId });
    return rows.length > 0;
  }

  /**
   * Advance the legacy JWT cutoff on verified recovery or logout-all, without
   * changing the customer's password. No credential means no mutation: OTP-only
   * customers remain on the legacy compatibility path.
   *
   * Call this from the owning authentication service in the SAME transaction
   * as its session revocations/audit changes. This repository alone does not
   * establish authentication or cross-repository transaction boundaries.
   */
  async advanceLegacyTokenCutoff(customerId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(customerCredentials)
      .set({
        legacyTokensInvalidBefore: sql`GREATEST(${customerCredentials.legacyTokensInvalidBefore}, ${now})`,
        updatedAt: sql`GREATEST(${customerCredentials.updatedAt}, ${now})`,
      })
      .where(eq(customerCredentials.customerId, customerId))
      .returning({ customerId: customerCredentials.customerId });
    return rows.length > 0;
  }

  /** Records a successful password check, for the recent-verification step-up window. */
  async markVerified(customerId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(customerCredentials)
      .set({ lastVerifiedAt: now, updatedAt: now })
      .where(eq(customerCredentials.customerId, customerId))
      .returning({ customerId: customerCredentials.customerId });
    return rows.length > 0;
  }
}
