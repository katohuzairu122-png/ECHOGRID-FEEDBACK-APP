import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { AppError } from '../lib/errors';
import { formatDecimal, parseDecimal } from './decimal';
import type { EvidenceLevel } from './attribution-foundation';

/**
 * G4 acquisition EVIDENCE reader. It only COUNTS what the platform already records (invitations issued, memberships created by onboarding source, cashier-recorded purchase events); it persists
 * nothing, creates no new event ledger and duplicates no financial or customer ledger. Every number carries its evidence level; nothing is promoted to a higher rung (a recorded purchase is
 * never "settled revenue"). Discovery, profile visits, Community interactions, verified referrals and verified registration are NOT recorded or NOT defined, so they are reported
 * `{ available: false, reason }`, never zero. Privacy: an explicit minimum group size is REQUIRED (none is defaulted); if any non-empty group is below it the WHOLE report is suppressed
 * (all-or-nothing, so differencing cannot reveal a small group). Aggregates only: no customer identity leaves this function.
 */
export type Unavailable = { available: false; reason: string };
export type Counted = { available: true; count: number; evidenceLevel: EvidenceLevel };
const na = (reason: string): Unavailable => ({ available: false, reason });

export interface AcquisitionReport {
  businessId: string; period: { start: string; end: string }; minGroupSize: number; suppressed: boolean;
  invitationsIssued: Counted | Unavailable; invitationsRevoked: Counted | Unavailable;
  enrollments: Counted | Unavailable; enrollmentsBySource: Record<string, Counted> | Unavailable;
  recordedPurchases: Counted | Unavailable; recordedPurchaseCustomers: Counted | Unavailable;
  recordedPurchaseAmount: { available: true; amount: string; currency: string; evidenceLevel: EvidenceLevel } | Unavailable;
  discovery: Unavailable; profileVisits: Unavailable; communityInteractions: Unavailable; verifiedReferrals: Unavailable; verifiedRegistration: Unavailable; attributedRevenue: Unavailable; roas: Unavailable; customerLifetimeValue: Unavailable;
}

const NOT_RECORDED = (what: string) => na(`${what}_NOT_RECORDED`);

export async function acquisitionEvidence(db: Db, businessId: string, period: { start: Date; end: Date }, opts: { minGroupSize: number | undefined }): Promise<AcquisitionReport> {
  if (!Number.isInteger(opts.minGroupSize) || (opts.minGroupSize as number) < 2) throw new AppError('An explicit privacy minimum group size of at least 2 is required.', 422, 'PRIVACY_THRESHOLD_REQUIRED');
  const min = opts.minGroupSize as number;
  if (!(period.start.getTime() < period.end.getTime())) throw new AppError('The period is invalid.', 422, 'MEASUREMENT_PERIOD_INVALID');
  const s = period.start.toISOString(); const e = period.end.toISOString();
  const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await db.execute<T>(q)).rows[0];
  const biz = await one<{ cur: string }>(sql`SELECT default_currency AS cur FROM businesses WHERE id = ${businessId}`);
  if (!biz) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
  const inv = (await one<{ issued: number; revoked: number }>(sql`SELECT count(*)::int AS issued, count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked FROM customer_invitations WHERE business_id = ${businessId} AND created_at >= ${s}::timestamptz AND created_at < ${e}::timestamptz`))!;
  const enr = (await db.execute<{ src: string | null; n: number }>(sql`SELECT onboarding_source AS src, count(*)::int AS n FROM business_customer_memberships WHERE business_id = ${businessId} AND joined_at >= ${s}::timestamptz AND joined_at < ${e}::timestamptz AND is_deleted = false GROUP BY onboarding_source`)).rows;
  const pur = (await one<{ n: number; customers: number; amount: string | null }>(sql`SELECT count(*)::int AS n, count(DISTINCT customer_id)::int AS customers, COALESCE(sum(qualifying_amount), 0)::text AS amount FROM loyalty_purchase_events WHERE business_id = ${businessId} AND payment_status = 'confirmed' AND occurred_at >= ${s}::timestamptz AND occurred_at < ${e}::timestamptz`))!;

  const groups = [inv.issued, inv.revoked, ...enr.map((r) => r.n), pur.n, pur.customers];
  const suppressed = groups.some((g) => g > 0 && g < min);
  const base = { businessId, period: { start: s, end: e }, minGroupSize: min, suppressed };
  const un = {
    discovery: NOT_RECORDED('BUSINESS_DISCOVERY'), profileVisits: NOT_RECORDED('BUSINESS_PROFILE_VISITS'), communityInteractions: NOT_RECORDED('COMMUNITY_INTERACTIONS'),
    verifiedReferrals: na('VERIFIED_REFERRAL_DEFINITION_NOT_APPROVED'), verifiedRegistration: na('VERIFIED_REGISTRATION_DEFINITION_NOT_APPROVED'),
    attributedRevenue: na('ATTRIBUTION_POLICY_NOT_APPROVED'), roas: na('ATTRIBUTION_POLICY_AND_ADVERTISING_SPEND_EVIDENCE_REQUIRED'), customerLifetimeValue: na('LIFETIME_VALUE_DEFINITION_NOT_APPROVED'),
  };
  if (suppressed) {
    const sup = na('SUPPRESSED_BELOW_PRIVACY_THRESHOLD');
    return { ...base, invitationsIssued: sup, invitationsRevoked: sup, enrollments: sup, enrollmentsBySource: sup, recordedPurchases: sup, recordedPurchaseCustomers: sup, recordedPurchaseAmount: sup, ...un };
  }
  const c = (count: number, evidenceLevel: EvidenceLevel): Counted => ({ available: true, count, evidenceLevel });
  const bySource: Record<string, Counted> = {}; for (const r of enr) bySource[r.src ?? 'unknown'] = c(r.n, 'verified_acquisition');
  return {
    ...base,
    invitationsIssued: c(inv.issued, 'observed_interaction'), invitationsRevoked: c(inv.revoked, 'observed_interaction'),
    enrollments: c(enr.reduce((t, r) => t + r.n, 0), 'verified_acquisition'), enrollmentsBySource: bySource,
    recordedPurchases: c(pur.n, 'recorded_transaction'), recordedPurchaseCustomers: c(pur.customers, 'recorded_transaction'),
    recordedPurchaseAmount: { available: true, amount: formatDecimal(parseDecimal(pur.amount ?? '0')), currency: biz.cur, evidenceLevel: 'recorded_transaction' },
    ...un,
  };
}
