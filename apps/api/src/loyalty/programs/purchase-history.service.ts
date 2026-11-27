import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { customers, loyaltyPurchaseEvents, loyaltyTransactions } from '../../db/schema';
import { AppError } from '../../lib/errors';

export interface PurchaseHistoryItem {
  id: string;
  accountId: string;
  customerName: string | null;
  occurredAt: Date;
  channel: string;
  /** The qualifying amount exactly as stored (decimal text), never a floating-point number. */
  amount: string;
  status: 'confirmed' | 'refunded' | 'reversed';
  pointsEarned: number;
  /** Present once the purchase has been reversed: when, and how many points were taken back versus could not be. */
  reversal: { reversedAt: Date; pointsReversed: number; pointsShortfall: number } | null;
}

const REVERSAL_NOTE = /^Reversal of purchase ([0-9a-f-]{36})/i;

async function attachDetails(db: Database, rows: { id: string; accountId: string; customerName: string | null; occurredAt: Date; channel: string; amount: string; status: string }[]): Promise<PurchaseHistoryItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const earned = await db
    .select({ purchaseEventId: loyaltyTransactions.purchaseEventId, points: sql<number>`coalesce(sum(${loyaltyTransactions.points}), 0)::int` })
    .from(loyaltyTransactions)
    .where(and(inArray(loyaltyTransactions.purchaseEventId, ids), eq(loyaltyTransactions.type, 'purchase')))
    .groupBy(loyaltyTransactions.purchaseEventId);
  const earnedBy = new Map(earned.map((e) => [e.purchaseEventId, e.points]));

  const reversedIds = new Set(rows.filter((r) => r.status === 'reversed').map((r) => r.id));
  const reversalBy = new Map<string, { reversedAt: Date; taken: number }>();
  if (reversedIds.size > 0) {
    const accounts = [...new Set(rows.filter((r) => reversedIds.has(r.id)).map((r) => r.accountId))];
    const adjustments = await db
      .select({ notes: loyaltyTransactions.notes, points: loyaltyTransactions.points, createdAt: loyaltyTransactions.createdAt })
      .from(loyaltyTransactions)
      .where(and(inArray(loyaltyTransactions.loyaltyAccountId, accounts), eq(loyaltyTransactions.type, 'adjustment'), sql`${loyaltyTransactions.notes} LIKE 'Reversal of purchase %'`));
    for (const a of adjustments) {
      const id = REVERSAL_NOTE.exec(a.notes ?? '')?.[1]?.toLowerCase();
      if (id) reversalBy.set(id, { reversedAt: a.createdAt, taken: Math.abs(a.points) });
    }
  }
  return rows.map((r) => {
    const pointsEarned = earnedBy.get(r.id) ?? 0;
    const hit = reversalBy.get(r.id);
    return {
      id: r.id,
      accountId: r.accountId,
      customerName: r.customerName,
      occurredAt: r.occurredAt,
      channel: r.channel,
      amount: r.amount,
      status: r.status as PurchaseHistoryItem['status'],
      pointsEarned,
      // A reversal that took no points (the purchase earned none, or the balance was already zero) leaves no ledger row; it is still a reversal.
      reversal: r.status === 'reversed' ? { reversedAt: hit?.reversedAt ?? r.occurredAt, pointsReversed: hit?.taken ?? 0, pointsShortfall: Math.max(0, pointsEarned - (hit?.taken ?? 0)) } : null,
    };
  });
}

const base = (db: Database) =>
  db
    .select({
      id: loyaltyPurchaseEvents.id,
      accountId: loyaltyPurchaseEvents.loyaltyAccountId,
      customerName: customers.fullName,
      occurredAt: loyaltyPurchaseEvents.occurredAt,
      channel: loyaltyPurchaseEvents.channel,
      amount: loyaltyPurchaseEvents.qualifyingAmount,
      status: loyaltyPurchaseEvents.paymentStatus,
    })
    .from(loyaltyPurchaseEvents)
    .innerJoin(customers, eq(customers.id, loyaltyPurchaseEvents.customerId));

/** LPC-10: the business's purchases, newest first, for the Owner's reversal screens. Always scoped to the caller's business. */
export async function listPurchases(
  db: Database,
  input: { businessId: string; status?: 'confirmed' | 'reversed' | undefined; accountId?: string | undefined; limit: number; offset: number },
): Promise<{ items: PurchaseHistoryItem[]; hasMore: boolean }> {
  const where = and(
    eq(loyaltyPurchaseEvents.businessId, input.businessId),
    input.status ? eq(loyaltyPurchaseEvents.paymentStatus, input.status) : undefined,
    input.accountId ? eq(loyaltyPurchaseEvents.loyaltyAccountId, input.accountId) : undefined,
  );
  const rows = await base(db).where(where).orderBy(desc(loyaltyPurchaseEvents.occurredAt), desc(loyaltyPurchaseEvents.id)).limit(input.limit + 1).offset(input.offset);
  return { items: await attachDetails(db, rows.slice(0, input.limit)), hasMore: rows.length > input.limit };
}

export async function getPurchase(db: Database, businessId: string, purchaseEventId: string): Promise<PurchaseHistoryItem> {
  const [row] = await base(db).where(and(eq(loyaltyPurchaseEvents.id, purchaseEventId), eq(loyaltyPurchaseEvents.businessId, businessId))).limit(1);
  if (!row) throw new AppError('Purchase not found.', 404, 'PURCHASE_NOT_FOUND');
  return (await attachDetails(db, [row]))[0]!;
}
