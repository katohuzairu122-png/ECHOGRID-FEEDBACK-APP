import { and, eq } from 'drizzle-orm';
import { customerDeletionRequests, CUSTOMER_DELETION_RESTORE_DAYS } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CustomerDeletionRequest = typeof customerDeletionRequests.$inferSelect;
const DAY_MS = 86_400_000;

export class CustomerDeletionRequestRepository extends BaseRepository {
  /** The one pending request, if any. Hot path: one indexed lookup on every customer request. */
  async findPending(customerId: string): Promise<CustomerDeletionRequest | null> {
    const [row] = await this.db
      .select()
      .from(customerDeletionRequests)
      .where(and(eq(customerDeletionRequests.customerId, customerId), eq(customerDeletionRequests.status, 'pending')))
      .limit(1);
    return row ?? null;
  }

  /** Idempotent: a customer with a pending request gets that request back (created=false). */
  async fileOrGetPending(customerId: string, now: Date): Promise<{ request: CustomerDeletionRequest; created: boolean }> {
    const [row] = await this.db
      .insert(customerDeletionRequests)
      .values({ customerId, requestedAt: now, scheduledFor: new Date(now.getTime() + CUSTOMER_DELETION_RESTORE_DAYS * DAY_MS) })
      .onConflictDoNothing()
      .returning();
    if (row) return { request: row, created: true };
    const existing = await this.findPending(customerId);
    if (!existing) throw new Error('Deletion request neither inserted nor found');
    return { request: existing, created: false };
  }

  /** pending -> cancelled only. Returns the cancelled row, or null when nothing was pending. */
  async cancelPending(customerId: string, now: Date): Promise<CustomerDeletionRequest | null> {
    const [row] = await this.db
      .update(customerDeletionRequests)
      .set({ status: 'cancelled', cancelledAt: now })
      .where(and(eq(customerDeletionRequests.customerId, customerId), eq(customerDeletionRequests.status, 'pending')))
      .returning();
    return row ?? null;
  }
}
