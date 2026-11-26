import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, shuffleCampaignVersions, shuffleCampaigns, shuffleDropAllocations, shuffleEntries, shuffleSelectionResults, dropReservations } from '../db/schema';
import { AppError } from '../lib/errors';
import { ShuffleParticipationService } from './shuffle-participation.service';
import { DropSponsorshipService } from '../drops/drop-sponsorship.service';

export type Actor = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };
const conflict = (m: string, code: string) => new AppError(m, 409, code);
type Outcome = 'linked' | 'already_linked' | 'not_eligible' | 'inventory_exhausted' | 'sponsorship_unavailable' | 'failed';
export interface EntryOutcome { entryId: string; outcome: Outcome; reservationId?: string }

/**
 * TSH-04 synthetic ORCHESTRATION: verified selection evidence -> reservation -> allocation -> durable link, per selected entry, each in ONE transaction (a failure leaves no stranded
 * reservation; re-running resumes the unlinked entries). Selection, reservation, allocation and collection stay different events: this service never collects, fulfils, returns an
 * allocated unit or invents a withdrawal policy. The Drops eligibility re-check (shared qualification engine) and the inventory guard are the existing ones; nothing is bypassed.
 * Requires BOTH Shuffle and Drops (the routes enforce each control); the hold expiry is supplied by the administrator, never defaulted.
 */
export class ShuffleDropAllocationService {
  constructor(private readonly db: Db) {}

  async allocateSelected(versionId: string, sponsorshipId: string, holdExpiresAt: Date, ctx: Actor) {
    const [v] = await this.db.select().from(shuffleCampaignVersions).where(eq(shuffleCampaignVersions.id, versionId)).limit(1);
    if (!v) throw new AppError('Campaign version not found.', 404, 'CAMPAIGN_NOT_FOUND');
    const [campaign] = await this.db.select().from(shuffleCampaigns).where(eq(shuffleCampaigns.id, v.campaignId)).limit(1);
    if (campaign?.status !== 'draft') throw conflict('The campaign is not active.', 'CAMPAIGN_NOT_DRAFT');
    const [sel] = await this.db.select().from(shuffleSelectionResults).where(eq(shuffleSelectionResults.campaignVersionId, versionId)).limit(1);
    if (!sel) throw conflict('No selection has been recorded for this campaign version.', 'SELECTION_NOT_RECORDED');
    // the selection must verify (chain + replay) BEFORE anything is allocated from it
    const ev = await new ShuffleParticipationService(this.db).verifyEvidence(versionId);
    if (!ev.chainOk || ev.selectionOk !== true) throw conflict('The recorded selection evidence does not verify, so nothing is allocated from it.', 'SELECTION_EVIDENCE_INVALID');
    const entries = await this.db.select({ id: shuffleEntries.id, customerId: shuffleEntries.customerId, status: shuffleEntries.status }).from(shuffleEntries).where(inArray(shuffleEntries.id, sel.selectedEntryIds));
    const outcomes: EntryOutcome[] = [];
    for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) outcomes.push(await this.one(sel.id, versionId, sponsorshipId, e, holdExpiresAt, ctx));
    const linked = outcomes.filter((o) => o.outcome === 'linked' || o.outcome === 'already_linked').length;
    return { selectionResultId: sel.id, mode: v.mode, selected: entries.length, linked, outcomes, guaranteedModeShortfall: v.mode === 'guaranteed' ? entries.length - linked : null };
  }

  private async one(selectionId: string, versionId: string, sponsorshipId: string, e: { id: string; customerId: string; status: string }, holdExpiresAt: Date, ctx: Actor): Promise<EntryOutcome> {
    const [existing] = await this.db.select().from(shuffleDropAllocations).where(eq(shuffleDropAllocations.entryId, e.id)).limit(1);
    if (existing) return { entryId: e.id, outcome: 'already_linked', reservationId: existing.reservationId };
    if (e.status !== 'admitted') return { entryId: e.id, outcome: 'not_eligible' };
    try {
      return await this.db.transaction(async (tx) => {
        const db = tx as unknown as Db;
        await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'shuffle_drop_link:' + e.id}, 0))`);
        const [again] = await db.select().from(shuffleDropAllocations).where(eq(shuffleDropAllocations.entryId, e.id)).limit(1);
        if (again) return { entryId: e.id, outcome: 'already_linked' as const, reservationId: again.reservationId };
        const drops = new DropSponsorshipService(db);
        const reserved = await drops.reserve(sponsorshipId, e.customerId, holdExpiresAt, ctx); // eligibility (shared engine) + atomic inventory
        const res = await drops.allocate(reserved.reservation.id, ctx);                           // re-validates eligibility immediately before allocation
        void res;
        await db.insert(shuffleDropAllocations).values({ selectionResultId: selectionId, campaignVersionId: versionId, entryId: e.id, customerId: e.customerId, sponsorshipId, reservationId: reserved.reservation.id, createdByUserId: ctx.actorUserId });
        await db.insert(auditLog).values({ businessId: null, actorUserId: ctx.actorUserId, action: 'shuffle_drop_allocation.linked', entityType: 'shuffle_campaign', entityId: versionId, metadata: { outcome: 'success', synthetic: true, entryId: e.id, sponsorshipId, reservationId: reserved.reservation.id }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null });
        return { entryId: e.id, outcome: 'linked' as const, reservationId: reserved.reservation.id };
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : '';
      if (code === 'INVENTORY_EXHAUSTED') return { entryId: e.id, outcome: 'inventory_exhausted' };
      if (code === 'ELIGIBILITY_NOT_MET' || code === 'QUALIFICATION_NOT_APPROVED') return { entryId: e.id, outcome: 'not_eligible' };
      if (code === 'SPONSORSHIP_NOT_AVAILABLE' || code === 'OFFER_EXPIRED') return { entryId: e.id, outcome: 'sponsorship_unavailable' };
      return { entryId: e.id, outcome: 'failed' }; // the whole per-entry transaction rolled back: no stranded reservation; a re-run resumes
    }
  }

  /** Aggregate lifecycle of the links for a version (identity-free): selection -> reservation -> allocation -> collection stay separate counts. */
  async status(versionId: string) {
    const [sel] = await this.db.select({ id: shuffleSelectionResults.id, winners: shuffleSelectionResults.winnerCount }).from(shuffleSelectionResults).where(eq(shuffleSelectionResults.campaignVersionId, versionId)).limit(1);
    const rows = await this.db.select({ status: dropReservations.status, n: sql<number>`count(*)::int` }).from(shuffleDropAllocations).innerJoin(dropReservations, eq(dropReservations.id, shuffleDropAllocations.reservationId)).where(eq(shuffleDropAllocations.campaignVersionId, versionId)).groupBy(dropReservations.status);
    const c = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return { selectionRecorded: !!sel, selected: sel ? sel.winners : null, linked: rows.reduce((a, r) => a + r.n, 0), allocated: c('allocated'), collected: c('collected'), expired: c('expired'), released: c('released'), reserved: c('reserved') };
  }
}
