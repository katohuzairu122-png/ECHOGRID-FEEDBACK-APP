import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { canonicalJson } from '../lib/audit-chain';
import { ShuffleParticipationService } from '../shuffle/shuffle-participation.service';
import { DropSponsorshipService } from '../drops/drop-sponsorship.service';
import { TentashipAnalytics } from '../analytics/tentaship-analytics';

/**
 * TSH-08 fraud SIGNALS: read-only detectors over canonical evidence (no new data is stored here). A signal is INFORMATION for a human reviewer:
 *  - no threshold is invented (each detector is a structural invariant or an exact comparison, never a score),
 *  - nothing is penalized, blocked, withdrawn or reversed automatically (opening a case needs an operator; any effect needs an approved override),
 *  - what the recorded evidence cannot support is reported as UNAVAILABLE, not as "no fraud".
 */
export type SignalCode =
  | 'self_referral' | 'referral_cycle' | 'evidence_customer_mismatch' | 'admitted_without_eligibility' | 'duplicate_allocation'
  | 'inventory_inconsistent' | 'evidence_chain_broken' | 'selection_replay_mismatch';
export interface FraudSignal { key: string; code: SignalCode; classification: string; refs: string[]; detail: string }
export const SIGNAL_CLASSIFICATION: Record<SignalCode, string> = {
  self_referral: 'suspected_self_referral', referral_cycle: 'suspected_referral_cycle', evidence_customer_mismatch: 'suspected_fabricated_evidence',
  admitted_without_eligibility: 'suspected_qualification_manipulation', duplicate_allocation: 'suspected_duplicate_allocation',
  inventory_inconsistent: 'suspected_inventory_manipulation', evidence_chain_broken: 'suspected_evidence_tampering', selection_replay_mismatch: 'suspected_evidence_tampering',
};
/** Signals the recorded evidence cannot support today: unavailable, never "clean". */
export const UNAVAILABLE_SIGNALS = {
  suspicious_repeated_collection_attempts: 'REJECTED_COLLECTION_ATTEMPTS_ARE_NOT_RECORDED',
  unauthorized_account_activity: 'NO_ACCOUNT_ACTIVITY_EVIDENCE_IN_THIS_MODULE',
  duplicate_participation_across_identities: 'NO_IDENTITY_LINKAGE_EVIDENCE_EXISTS',
} as const;

const mk = (code: SignalCode, refs: string[], detail: string): FraudSignal => {
  const sorted = [...refs].sort();
  return { key: createHash('sha256').update(canonicalJson({ code, refs: sorted })).digest('hex'), code, classification: SIGNAL_CLASSIFICATION[code], refs: sorted, detail };
};
const rows = async <T>(db: Db, q: ReturnType<typeof sql>) => ((await db.execute<T & Record<string, unknown>>(q)).rows ?? []) as T[];

export class FraudSignals {
  constructor(private readonly db: Db) {}

  /** Referral manipulation: a customer referring themselves, or two customers referring each other. Exact comparisons over customer_referrals. */
  async scanReferrals(): Promise<FraudSignal[]> {
    const self = await rows<{ id: string }>(this.db, sql`select id from customer_referrals where referring_customer_id is not null and referring_customer_id = referred_customer_id`);
    const cycles = await rows<{ a: string; b: string }>(this.db, sql`select r1.id as a, r2.id as b from customer_referrals r1 join customer_referrals r2 on r1.referring_customer_id = r2.referred_customer_id and r1.referred_customer_id = r2.referring_customer_id and r1.id < r2.id`);
    return [...self.map((r) => mk('self_referral', [r.id], 'A referral names the same customer as referrer and referred.')), ...cycles.map((c) => mk('referral_cycle', [c.a, c.b], 'Two customers refer each other.'))];
  }

  /** Per campaign version: evidence in an eligibility snapshot that belongs to ANOTHER customer, admitted entries with no qualified snapshot, structural duplicates and chain/selection integrity. */
  async scanShuffleVersion(versionId: string): Promise<FraudSignal[]> {
    const out: FraudSignal[] = [];
    const mismatch = await rows<{ snapshot_id: string; evidence_id: string }>(this.db, sql`
      select s.id as snapshot_id, e.id as evidence_id from shuffle_eligibility_snapshots s
      cross join lateral jsonb_array_elements_text(coalesce(s.evidence->'evidenceIds', '[]'::jsonb)) ev(id)
      join loyalty_purchase_events e on e.id::text = ev.id and e.customer_id <> s.customer_id where s.campaign_version_id = ${versionId}`);
    for (const m of mismatch) out.push(mk('evidence_customer_mismatch', [m.snapshot_id, m.evidence_id], 'An eligibility snapshot cites purchase evidence recorded for a different customer.'));
    const noElig = await rows<{ id: string }>(this.db, sql`
      select e.id from shuffle_entries e left join shuffle_invitations i on i.id = e.invitation_id left join shuffle_eligibility_snapshots s on s.id = i.snapshot_id
      where e.campaign_version_id = ${versionId} and e.status = 'admitted' and coalesce(s.qualified, false) = false`);
    for (const r of noElig) out.push(mk('admitted_without_eligibility', [r.id], 'An admitted entry has no qualified eligibility snapshot behind its invitation.'));
    const dup = await rows<{ customer_id: string; ids: string[] }>(this.db, sql`select customer_id, array_agg(id::text order by id) as ids from shuffle_entries where campaign_version_id = ${versionId} and status in ('accepted','admitted') group by customer_id having count(*) > 1`);
    for (const d of dup) out.push(mk('duplicate_allocation', d.ids, 'More than one live entry exists for one customer in one campaign version.'));
    const ev = await new ShuffleParticipationService(this.db).verifyEvidence(versionId);
    if (!ev.chainOk) out.push(mk('evidence_chain_broken', [versionId], 'The campaign evidence chain does not verify.'));
    if (ev.selectionRecorded && ev.selectionOk === false) out.push(mk('selection_replay_mismatch', [versionId], 'The recorded selection does not replay from its recorded draws and entrants.'));
    return out;
  }

  /** Per sponsorship: inventory counters vs canonical reservations, duplicate live allocations per customer, evidence chain. */
  async scanSponsorship(sponsorshipId: string): Promise<FraudSignal[]> {
    const out: FraudSignal[] = [];
    const dup = await rows<{ customer_id: string; ids: string[] }>(this.db, sql`select customer_id, array_agg(id::text order by id) as ids from drop_reservations where sponsorship_id = ${sponsorshipId} and status in ('reserved','allocated','collected') group by customer_id having count(*) > 1`);
    for (const d of dup) out.push(mk('duplicate_allocation', d.ids, 'More than one live reservation or allocation exists for one customer on one sponsorship.'));
    const ev = await new DropSponsorshipService(this.db).verifyEvidence(sponsorshipId);
    if (!ev.chainOk) out.push(mk('evidence_chain_broken', [sponsorshipId], 'The sponsorship evidence chain does not verify.'));
    if (!ev.inventoryConsistent) out.push(mk('inventory_inconsistent', [sponsorshipId], 'The inventory counters do not equal the counts derived from reservations and evidence.'));
    const a = await new TentashipAnalytics(this.db).dropSponsorship(sponsorshipId);
    if (a.metrics && a.metrics.reconciled === false && ev.inventoryConsistent) out.push(mk('inventory_inconsistent', [sponsorshipId], 'The analytics reconciliation disagrees with the inventory counters.'));
    return out;
  }
}
