import { eq } from 'drizzle-orm';
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
      .set({ passwordHash: input.passwordHash, passwordChangedAt: input.now, updatedAt: input.now })
      .where(eq(customerCredentials.customerId, input.customerId))
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
