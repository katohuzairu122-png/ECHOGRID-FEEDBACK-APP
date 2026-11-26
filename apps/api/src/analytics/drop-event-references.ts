import { asc, and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { dropEvents, dropSponsorships } from '../db/schema';
import { AppError } from '../lib/errors';

/**
 * TDP-04 -> TSH-07 handoff: canonical, IDENTITY-FREE references to the sponsorship's recorded events. Every reference points at one row of the append-only
 * evidence chain (id, seq, hash), so TSH-07 can count and join distinct lifecycle events without a second ledger. Each event type stays separately identifiable and none
 * is evidence of another: a collection is NOT proof of a qualifying purchase, and any interaction is NOT proof of customer acquisition. No customer, staff or
 * reservation-holder identity, and no free text, is included.
 */
export const DROP_EVENT_KINDS = {
  reserved: 'A hold was taken on one unit.',
  allocated: 'A held unit was allocated after eligibility was re-checked.',
  collected: 'A verified collection was recorded inside the collection window.',
  released: 'A hold was released before allocation.',
  hold_expired: 'A hold passed its expiry before allocation.',
  allocation_expired: 'An allocated unit passed the collection window uncollected (not returned to the pool).',
  approved: 'The sponsorship version was approved by an independent reviewer.',
} as const;
export const NOT_EVIDENCE_OF = ['qualifying_purchase', 'customer_acquisition', 'revenue', 'return_on_investment', 'incremental_sales', 'customer_lifetime_value', 'sponsor_profitability'] as const;
export interface DropEventReference { eventId: string; seq: number; hash: string; kind: keyof typeof DROP_EVENT_KINDS; occurredAt: string }

export async function dropEventReferences(db: Db, sponsorshipId: string, opts: { afterSeq?: number } = {}) {
  const [s] = await db.select({ id: dropSponsorships.id }).from(dropSponsorships).where(eq(dropSponsorships.id, sponsorshipId)).limit(1);
  if (!s) throw new AppError('Sponsorship not found.', 404, 'SPONSORSHIP_NOT_FOUND');
  const rows = await db.select().from(dropEvents).where(and(eq(dropEvents.sponsorshipId, sponsorshipId), gt(dropEvents.seq, opts.afterSeq ?? 0))).orderBy(asc(dropEvents.seq));
  const refs: DropEventReference[] = rows.filter((r) => typeof r.event.type === 'string' && r.event.type in DROP_EVENT_KINDS)
    .map((r) => ({ eventId: r.id, seq: r.seq, hash: r.hash, kind: r.event.type as DropEventReference['kind'], occurredAt: r.createdAt.toISOString() }));
  return { sponsorshipId, references: refs, kinds: DROP_EVENT_KINDS, notEvidenceOf: NOT_EVIDENCE_OF, lastSeq: rows.at(-1)?.seq ?? opts.afterSeq ?? 0 };
}
