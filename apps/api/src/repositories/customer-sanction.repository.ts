import { and, desc, eq, sql } from 'drizzle-orm';
import { customerSanctions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CustomerSanction = typeof customerSanctions.$inferSelect;
export type CustomerSanctionAction = 'warning' | 'limit' | 'suspend' | 'ban' | 'lift';

/** Append-only. There is deliberately no update or delete. */
export class CustomerSanctionRepository extends BaseRepository {
  async record(input: {
    customerId: string;
    action: CustomerSanctionAction;
    reason: string;
    suspendedUntil?: Date | null;
    actorUserId: string | null;
  }): Promise<CustomerSanction> {
    const [row] = await this.db
      .insert(customerSanctions)
      .values({
        customerId: input.customerId,
        action: input.action,
        reason: input.reason,
        suspendedUntil: input.suspendedUntil ?? null,
        actorUserId: input.actorUserId,
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async listForCustomer(customerId: string, limit = 50): Promise<CustomerSanction[]> {
    return this.db
      .select()
      .from(customerSanctions)
      .where(eq(customerSanctions.customerId, customerId))
      .orderBy(desc(customerSanctions.createdAt))
      .limit(limit);
  }

  async countWarnings(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(customerSanctions)
      .where(
        and(eq(customerSanctions.customerId, customerId), eq(customerSanctions.action, 'warning')),
      );
    return row?.n ?? 0;
  }
}
