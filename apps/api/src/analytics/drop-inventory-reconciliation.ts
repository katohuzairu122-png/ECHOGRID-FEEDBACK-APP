import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { dropEvents, dropInventory, dropReservations, dropSponsorshipVersions, dropSponsorships } from '../db/schema';
import { AppError } from '../lib/errors';
import { verifyChain, type AuditLink } from '../lib/audit-chain';

/**
 * TDP-04 canonical inventory reconciliation. READ-ONLY: it compares the single authoritative inventory row with counts DERIVED independently from the reservation
 * table and the hash-chained evidence, and it NEVER repairs anything. A failed check is reported with expected and actual values; the approved remediation boundary
 * is human review (a fraud signal and, if an operator chooses, a governance case): no automatic correction, no silent adjustment, no return of an allocated unit.
 *
 * CURRENT STATE (what the units are now) is kept apart from HISTORICAL ACTIVITY (what happened over time): a released or expired hold is activity, not an extra
 * inventory balance, and an uncollected allocation that expired is NOT returned to the pool (it stays in `expiredUnreturned`).
 */
export type CheckCode =
  | 'non_negative' | 'within_total' | 'total_matches_approved_version' | 'reserved_matches_reservations' | 'allocated_matches_reservations' | 'collected_matches_reservations'
  | 'expired_unreturned_matches_events' | 'every_reservation_in_exactly_one_state' | 'released_matches_events' | 'expired_holds_match_events' | 'expired_status_conserved'
  | 'available_excludes_expired_unreturned' | 'no_duplicate_live_units' | 'chain_verifies';
export interface ReconciliationCheck { code: CheckCode; ok: boolean; expected: number | boolean | string; actual: number | boolean | string; detail: string }
export interface Reconciliation {
  sponsorshipId: string; lifecycleStatus: string;
  current: { total: number; reserved: number; allocated: number; collected: number; expiredUnreturned: number; available: number } | null;
  historical: { reservationsCreated: number; holdsReleased: number; holdsExpired: number; allocationsExpired: number; additions: { available: false; reason: string } } | null;
  checks: ReconciliationCheck[]; ok: boolean; remediation: 'NONE_REQUIRED' | 'REVIEW_REQUIRED_NO_AUTOMATIC_REPAIR';
}
const n = (v: unknown) => Number(v ?? 0);

export async function reconcileDropInventory(db: Db, sponsorshipId: string): Promise<Reconciliation> {
  const [s] = await db.select({ id: dropSponsorships.id, status: dropSponsorships.status, approvedVersionId: dropSponsorships.approvedVersionId }).from(dropSponsorships).where(eq(dropSponsorships.id, sponsorshipId)).limit(1);
  if (!s) throw new AppError('Sponsorship not found.', 404, 'SPONSORSHIP_NOT_FOUND');
  const [inv] = await db.select().from(dropInventory).where(eq(dropInventory.sponsorshipId, sponsorshipId)).limit(1);
  if (!inv) return { sponsorshipId, lifecycleStatus: s.status, current: null, historical: null, checks: [], ok: true, remediation: 'NONE_REQUIRED' };

  const byStatus = await db.select({ status: dropReservations.status, c: sql<number>`count(*)::int` }).from(dropReservations).where(eq(dropReservations.sponsorshipId, sponsorshipId)).groupBy(dropReservations.status);
  const st = (k: string) => n(byStatus.find((x) => x.status === k)?.c);
  const events = await db.select().from(dropEvents).where(eq(dropEvents.sponsorshipId, sponsorshipId)).orderBy(asc(dropEvents.seq));
  const ev = (t: string) => events.filter((e) => e.event.type === t).length;
  const [ver] = s.approvedVersionId ? await db.select({ q: dropSponsorshipVersions.quantityTotal }).from(dropSponsorshipVersions).where(eq(dropSponsorshipVersions.id, s.approvedVersionId)).limit(1) : [];
  const dup = await db.execute<{ c: number }>(sql`select count(*)::int as c from (select customer_id from drop_reservations where sponsorship_id = ${sponsorshipId} and status in ('reserved','allocated','collected') group by customer_id having count(*) > 1) x`);
  const chain: AuditLink[] = events.map((e) => ({ prev: e.prevHash, hash: e.hash, event: e.event }));

  const reservationsCreated = st('reserved') + st('allocated') + st('collected') + st('released') + st('expired');
  const available = inv.totalQuantity - inv.reserved - inv.allocated - inv.collected - inv.expired;
  const allocExpiredEv = ev('allocation_expired'); const holdExpiredEv = ev('hold_expired');
  const eq_ = (code: CheckCode, expected: number, actual: number, detail: string): ReconciliationCheck => ({ code, ok: expected === actual, expected, actual, detail });
  const checks: ReconciliationCheck[] = [
    { code: 'non_negative', ok: [inv.reserved, inv.allocated, inv.collected, inv.expired, available].every((x) => x >= 0), expected: true, actual: [inv.reserved, inv.allocated, inv.collected, inv.expired, available].every((x) => x >= 0), detail: 'No counter and no available balance is negative.' },
    { code: 'within_total', ok: inv.reserved + inv.allocated + inv.collected + inv.expired <= inv.totalQuantity, expected: inv.totalQuantity, actual: inv.reserved + inv.allocated + inv.collected + inv.expired, detail: 'Units in use never exceed the sponsored total (no oversubscription).' },
    eq_('total_matches_approved_version', ver?.q ?? -1, inv.totalQuantity, 'The inventory total equals the quantity of the APPROVED sponsorship version (it is never edited afterwards).'),
    eq_('reserved_matches_reservations', st('reserved'), inv.reserved, 'The reserved counter equals the reservations currently in status reserved.'),
    eq_('allocated_matches_reservations', st('allocated'), inv.allocated, 'The allocated counter equals the reservations currently in status allocated.'),
    eq_('collected_matches_reservations', st('collected'), inv.collected, 'The collected counter equals the reservations currently in status collected.'),
    eq_('expired_unreturned_matches_events', allocExpiredEv, inv.expired, 'Units whose collection window passed uncollected equal the allocation_expired events; they are NOT returned to the pool.'),
    eq_('every_reservation_in_exactly_one_state', ev('reserved'), reservationsCreated, 'Every created reservation is in exactly one state: reserved events equal the reservation rows.'),
    eq_('released_matches_events', ev('released'), st('released'), 'Released holds equal the released events (each release is recorded once).'),
    eq_('expired_holds_match_events', holdExpiredEv, st('expired') - allocExpiredEv, 'Reservations in status expired split into expired holds and expired allocations, each matching its own event count.'),
    eq_('expired_status_conserved', st('expired'), holdExpiredEv + allocExpiredEv, 'Expired reservations equal expired holds plus expired allocations.'),
    eq_('available_excludes_expired_unreturned', inv.totalQuantity - (inv.reserved + inv.allocated + inv.collected + inv.expired), available, 'Available inventory counts neither in-use units nor expired uncollected allocations.'),
    eq_('no_duplicate_live_units', 0, n(dup.rows?.[0]?.c), 'No customer holds more than one live reservation, allocation or collection.'),
    { code: 'chain_verifies', ok: events.every((e, i) => e.seq === i + 1) && verifyChain(chain), expected: true, actual: events.every((e, i) => e.seq === i + 1) && verifyChain(chain), detail: 'The sponsorship evidence chain is contiguous and every hash recomputes.' },
  ];
  const ok = checks.every((c) => c.ok);
  return {
    sponsorshipId, lifecycleStatus: s.status,
    current: { total: inv.totalQuantity, reserved: inv.reserved, allocated: inv.allocated, collected: inv.collected, expiredUnreturned: inv.expired, available },
    historical: { reservationsCreated, holdsReleased: st('released'), holdsExpired: holdExpiredEv, allocationsExpired: allocExpiredEv, additions: { available: false, reason: 'INVENTORY_ADDITIONS_ARE_NOT_SUPPORTED_THE_TOTAL_IS_IMMUTABLE' } },
    checks, ok, remediation: ok ? 'NONE_REQUIRED' : 'REVIEW_REQUIRED_NO_AUTOMATIC_REPAIR',
  };
}
