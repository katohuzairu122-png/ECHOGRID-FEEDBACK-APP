import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { PathwayMeasure, QualificationPathway } from './qualification-spec';

/**
 * QUAL-PURCHASE-01: reads CANONICAL evidence only, from server-owned records written by already-authorised flows. It creates no new purchase,
 * payment or ledger. Clients and cashier input are never an argument here: the caller passes ids it resolved server-side.
 *
 * `recorded_purchases` counts loyalty_purchase_events for ONE customer whose payment_status is `confirmed` (refunded and reversed are excluded).
 * HONEST LIMIT: today the only writer sets `confirmed` when an authorised cashier records the purchase, and no flow flips it to refunded/reversed, so
 * this is RECORDED evidence, not proof of settled payment, and reversal exclusion is only as reliable as that status. The amount is compared as exact
 * SQL `numeric` and only within the business's own currency; evidence already consumed under the same rule version and consumer is excluded.
 */
export async function measureRecordedPurchases(
  db: Db,
  input: { customerId: string; pathway: QualificationPathway; ruleVersionId: string; consumerKind: 'referral' | 'badge' | 'campaign'; since?: Date | null; between?: { start: Date; end: Date } | null },
): Promise<PathwayMeasure> {
  const { pathway } = input;
  const since = pathway.sinceAttribution ? input.since ?? null : null;
  if (pathway.sinceAttribution && !since) return { observed: 0, evidenceIds: [] }; // no attribution moment known: count nothing (fail closed)
  const amount = pathway.minAmount === undefined ? sql`` : sql`and pe.qualifying_amount >= ${pathway.minAmount}::numeric and b.default_currency = ${pathway.currency}`;
  const sinceSql = since ? sql`and pe.occurred_at >= ${since.toISOString()}::timestamptz` : sql``;
  const betweenSql = input.between ? sql`and pe.occurred_at >= ${input.between.start.toISOString()}::timestamptz and pe.occurred_at < ${input.between.end.toISOString()}::timestamptz` : sql``;
  const windowSql = pathway.windowDays === undefined ? sql`` : sql`and pe.occurred_at >= now() - make_interval(days => ${pathway.windowDays})`;
  const res = await db.execute<{ id: string }>(sql`
    select pe.id
    from loyalty_purchase_events pe
    join businesses b on b.id = pe.business_id and b.status = 'active'
    where pe.customer_id = ${input.customerId} and pe.payment_status = 'confirmed' ${amount} ${sinceSql} ${betweenSql} ${windowSql}
      and not exists (
        select 1 from qualification_evidence_consumptions c
        where c.evidence_kind = 'purchase_event' and c.evidence_id = pe.id and c.rule_version_id = ${input.ruleVersionId} and c.consumer_kind = ${input.consumerKind}
      )
    order by pe.occurred_at, pe.id
    limit ${pathway.threshold}`);
  const ids = (res.rows ?? []).map((r) => r.id);
  return { observed: ids.length, evidenceIds: ids };
}
