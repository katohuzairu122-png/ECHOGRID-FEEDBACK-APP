import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  dropEvents, dropSponsorships, governanceCases, shuffleCampaignVersions, shuffleEligibilitySnapshots, shuffleEntries, shuffleInvitations, shuffleSelectionResults,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { reconcileDropInventory } from './drop-inventory-reconciliation';

/**
 * TDP-04 / TSH-07 aggregate analytics. EVERY number is derived from canonical records (no competing balance is stored) and has a documented definition below.
 * A metric the evidence cannot support is `{ available: false, reason }`, never zero and never an estimate. Customer identities never leave this module.
 * The privacy threshold is a REQUIRED explicit input for any externally scoped view (no default is invented, and it is separate from the Business Community
 * analytics threshold and from a campaign's own minimum participants); suppression is all-or-nothing over the customer-derived group so a hidden value
 * cannot be recovered by differencing (available = total - consumed) or by repeated queries.
 */
export type Metric = number | { available: false; reason: string };
const unavailable = (reason: string): Metric => ({ available: false, reason });

export const DROP_METRIC_DEFINITIONS = {
  total: 'drop_inventory.total_quantity: the quantity of the APPROVED sponsorship version (sponsor supply).',
  reserved: 'drop_inventory.reserved: reservations currently in status reserved (unconverted holds).',
  allocated: 'drop_inventory.allocated: reservations currently in status allocated and not yet collected or expired.',
  collected: 'drop_inventory.collected: reservations whose collection was verified inside the collection window.',
  allocationsExpired: 'drop_inventory.expired: allocated units not collected before the collection window ended; never returned to the pool.',
  available: 'total - reserved - allocated - collected - allocationsExpired (units a new reservation could still take).',
  reservationsCreated: 'HISTORICAL: every reservation ever created (one per customer per sponsorship); each is in exactly one state, so the states sum to this number. It is activity, not an inventory balance.',
  holdsReleased: 'count of reservations in status released (hold released before allocation, including failed eligibility re-checks and approved overrides).',
  holdsExpired: 'count of hold_expired events on the sponsorship evidence chain (a hold whose time passed before allocation).',
  outstandingCollection: 'allocated: units allocated and still collectable.',
  collectionCompletionRate: 'collected / (collected + allocated + allocationsExpired): the share of units EVER allocated that were collected. Unavailable when no unit was ever allocated.',
  reconciled: 'true when EVERY check of the canonical inventory reconciliation passes (counters vs counts derived independently from reservations and the evidence chain). A failure is reported, never repaired.',
} as const;

/** current = what the units are now; historical = activity over time (never an extra balance); derived = computed from current states; integrity = a verification result. */
export const DROP_METRIC_KINDS = {
  total: 'current', available: 'current', reserved: 'current', allocated: 'current', collected: 'current', allocationsExpired: 'current', outstandingCollection: 'current',
  reservationsCreated: 'historical', holdsReleased: 'historical', holdsExpired: 'historical', collectionCompletionRate: 'derived', reconciled: 'integrity',
} as const;

export const SHUFFLE_METRIC_DEFINITIONS = {
  eligibleSnapshots: 'shuffle_eligibility_snapshots with qualified = true: the shared qualification engine found the customer eligible at the snapshot time. Eligibility is NOT an invitation, an entry or a selection.',
  notEligibleSnapshots: 'shuffle_eligibility_snapshots with qualified = false.',
  invitationsIssued: 'shuffle_invitations rows (one per qualified snapshot): an offer was generated. Not eligibility, not acceptance.',
  invitationsAccepted: 'distinct invitations with an accepted event in shuffle_invitation_events (accepted at some time, even if later withdrawn).',
  invitationsDeclined: 'invitations currently declined.',
  invitationsExpired: 'invitations currently expired.',
  invitationsWithdrawn: 'invitations currently withdrawn (qualification invalidated or eligibility no longer met): invalidated evidence cannot yield participation.',
  participationRecorded: 'shuffle_entries rows: acceptance was recorded against the exact terms/disclosure hash. Not a selection.',
  participantsAdmitted: 'entries currently admitted (the selection input population).',
  entriesCancelled: 'entries currently cancelled (with a recorded reason).',
  participantsSelected: 'shuffle_selection_results.winner_count when a synthetic selection is recorded; unavailable (not zero) before then.',
  allocationRecorded: 'Shuffle entries carry no reward allocation in this block (allocation lives on Drops units and has no link to a Shuffle entry): unavailable.',
  rewardCollected: 'unavailable for the same reason as allocationRecorded.',
  governanceCases: 'governance_cases grouped by kind and status for this campaign version (platform view only).',
  revenueAttribution: 'unavailable: link clicks, impressions, QR scans, registrations and unverified purchases are not causal evidence.',
  returnOnAdSpend: 'unavailable: no spend or causal attribution evidence exists.',
  customerLifetimeValue: 'unavailable: not supported by the recorded evidence.',
  incrementalSales: 'unavailable: not supported by the recorded evidence.',
  sponsorProfitability: 'unavailable: no commercial or cost data exists by design.',
} as const;

const count = async (db: Db, text: ReturnType<typeof sql>) => { const r = await db.execute<{ n: number }>(text); return Number(r.rows?.[0]?.n ?? 0); };

export class TentashipAnalytics {
  constructor(private readonly db: Db) {}

  /** Full internal sponsorship analytics (platform use). */
  async dropSponsorship(sponsorshipId: string) {
    const [s] = await this.db.select({ id: dropSponsorships.id, businessId: dropSponsorships.businessId, status: dropSponsorships.status }).from(dropSponsorships).where(eq(dropSponsorships.id, sponsorshipId)).limit(1);
    if (!s) throw new AppError('Sponsorship not found.', 404, 'SPONSORSHIP_NOT_FOUND');
    const rec = await reconcileDropInventory(this.db, sponsorshipId);
    if (!rec.current || !rec.historical) return { sponsorshipId, status: s.status, metrics: null, reason: 'NO_INVENTORY_UNTIL_APPROVED' as const };
    const everAllocated = rec.current.collected + rec.current.allocated + rec.current.expiredUnreturned;
    return {
      sponsorshipId, businessId: s.businessId, status: s.status, kinds: DROP_METRIC_KINDS,
      metrics: {
        total: rec.current.total, reserved: rec.current.reserved, allocated: rec.current.allocated, collected: rec.current.collected, allocationsExpired: rec.current.expiredUnreturned, available: rec.current.available,
        reservationsCreated: rec.historical.reservationsCreated, holdsReleased: rec.historical.holdsReleased, holdsExpired: rec.historical.holdsExpired, outstandingCollection: rec.current.allocated,
        collectionCompletionRate: everAllocated === 0 ? unavailable('NO_ALLOCATION_YET') : rec.current.collected / everAllocated,
        reconciled: rec.ok,
      },
    };
  }

  /**
   * Sponsor-scoped view (INTERNAL service; NO external route exists until the Owner approves the sponsor permission model). The sponsorship must belong to
   * the business, `minimumGroupSize` is REQUIRED (no default), and customer-derived figures are suppressed together when the consumed population is smaller.
   */
  async dropSponsorshipForBusiness(businessId: string, sponsorshipId: string, opts: { minimumGroupSize: number }) {
    if (!Number.isInteger(opts.minimumGroupSize) || opts.minimumGroupSize < 1) throw new AppError('An explicit minimum group size is required.', 422, 'THRESHOLD_REQUIRED');
    const [own] = await this.db.select({ id: dropSponsorships.id }).from(dropSponsorships).where(and(eq(dropSponsorships.id, sponsorshipId), eq(dropSponsorships.businessId, businessId))).limit(1);
    if (!own) throw new AppError('Sponsorship not found.', 404, 'SPONSORSHIP_NOT_FOUND'); // another business's sponsorship is indistinguishable from a missing one
    const full = await this.dropSponsorship(sponsorshipId);
    if (!full.metrics) return { sponsorshipId, status: full.status, metrics: null, reason: full.reason };
    const m = full.metrics;
    const population = m.reservationsCreated;
    if (population > 0 && population < opts.minimumGroupSize) {
      const hidden = unavailable('SUPPRESSED_SMALL_GROUP');
      return { sponsorshipId, status: full.status, kinds: DROP_METRIC_KINDS, metrics: { total: m.total, reserved: hidden, allocated: hidden, collected: hidden, allocationsExpired: hidden, available: hidden, reservationsCreated: hidden, holdsReleased: hidden, holdsExpired: hidden, outstandingCollection: hidden, collectionCompletionRate: hidden, reconciled: m.reconciled } };
    }
    return { sponsorshipId, status: full.status, kinds: DROP_METRIC_KINDS, metrics: m };
  }

  /** Per-version Shuffle analytics (platform view). The lifecycle events are DIFFERENT and are never merged. */
  async shuffleVersion(versionId: string, opts: { includeGovernance: boolean }) {
    const [v] = await this.db.select({ id: shuffleCampaignVersions.id, campaignId: shuffleCampaignVersions.campaignId, minParticipants: shuffleCampaignVersions.minParticipants, maxCapacity: shuffleCampaignVersions.maxCapacity }).from(shuffleCampaignVersions).where(eq(shuffleCampaignVersions.id, versionId)).limit(1);
    if (!v) throw new AppError('Campaign version not found.', 404, 'CAMPAIGN_NOT_FOUND');
    const snaps = await this.db.select({ q: shuffleEligibilitySnapshots.qualified, n: sql<number>`count(*)::int` }).from(shuffleEligibilitySnapshots).where(eq(shuffleEligibilitySnapshots.campaignVersionId, versionId)).groupBy(shuffleEligibilitySnapshots.qualified);
    const inv = await this.db.select({ s: shuffleInvitations.status, n: sql<number>`count(*)::int` }).from(shuffleInvitations).where(eq(shuffleInvitations.campaignVersionId, versionId)).groupBy(shuffleInvitations.status);
    const ent = await this.db.select({ s: shuffleEntries.status, n: sql<number>`count(*)::int` }).from(shuffleEntries).where(eq(shuffleEntries.campaignVersionId, versionId)).groupBy(shuffleEntries.status);
    const accepted = await count(this.db, sql`select count(distinct e.invitation_id)::int as n from shuffle_invitation_events e join shuffle_invitations i on i.id = e.invitation_id where i.campaign_version_id = ${versionId} and e.to_status = 'accepted'`);
    const [sel] = await this.db.select({ winners: shuffleSelectionResults.winnerCount, entrants: shuffleSelectionResults.entrantCount }).from(shuffleSelectionResults).where(eq(shuffleSelectionResults.campaignVersionId, versionId)).limit(1);
    const n = <T extends { n: number }>(rows: (T & Record<string, unknown>)[], k: string, val: unknown) => Number(rows.find((r) => r[k] === val)?.n ?? 0);
    const gov = opts.includeGovernance
      ? await this.db.select({ kind: governanceCases.kind, status: governanceCases.status, n: sql<number>`count(*)::int` }).from(governanceCases).where(eq(governanceCases.campaignVersionId, versionId)).groupBy(governanceCases.kind, governanceCases.status)
      : null;
    const na = unavailable('NOT_SUPPORTED_BY_EVIDENCE');
    return {
      campaignVersionId: versionId, campaignId: v.campaignId,
      metrics: {
        eligibleSnapshots: n(snaps, 'q', true), notEligibleSnapshots: n(snaps, 'q', false),
        invitationsIssued: inv.reduce((a, r) => a + r.n, 0), invitationsAccepted: accepted, invitationsDeclined: n(inv, 's', 'declined'), invitationsExpired: n(inv, 's', 'expired'), invitationsWithdrawn: n(inv, 's', 'withdrawn'),
        participationRecorded: ent.reduce((a, r) => a + r.n, 0), participantsAdmitted: n(ent, 's', 'admitted'), entriesCancelled: n(ent, 's', 'cancelled'),
        participantsSelected: sel ? sel.winners : unavailable('SELECTION_NOT_RECORDED'),
        allocationRecorded: unavailable('NO_SHUFFLE_ALLOCATION_LINK'), rewardCollected: unavailable('NO_SHUFFLE_ALLOCATION_LINK'),
        governanceCases: gov ?? unavailable('NOT_AUTHORIZED_FOR_THIS_VIEW'),
        revenueAttribution: na, returnOnAdSpend: na, customerLifetimeValue: na, incrementalSales: na, sponsorProfitability: na,
      },
    };
  }

  async reconcileEventsOrder(sponsorshipId: string) { return this.db.select({ seq: dropEvents.seq }).from(dropEvents).where(eq(dropEvents.sponsorshipId, sponsorshipId)).orderBy(asc(dropEvents.seq)); }
  /** Exposed for tests: counts the accepted-event invitations a withdrawn invitation still counts toward (acceptance is history, not current state). */
  async acceptedEvents(versionId: string) { return count(this.db, sql`select count(*)::int as n from shuffle_invitation_events e join shuffle_invitations i on i.id = e.invitation_id where i.campaign_version_id = ${versionId} and e.to_status = 'accepted'`); }
}
