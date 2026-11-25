import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { customerReferrals, qualificationRuleVersions } from '../db/schema';
import { evaluateQualification, parseQualificationSpec, type PathwayMeasure } from '../qualification/qualification-spec';
import { measureRecordedPurchases } from '../qualification/qualification-evidence';

export type BadgeQualification = { ruleVersionId: string; specHash: string; evidenceIds: string[]; purchaseEvidenceIds: string[] };

/**
 * Tentaship Badges integration with the SHARED qualification engine (TSH-02 / QUAL-PURCHASE-01). Evaluates the APPROVED rule version for `ruleKey`
 * for ONE customer using server-measured evidence only, and fails CLOSED: no approved rule, an invalid spec, or insufficient evidence all return
 * null (no award). The badge ledger, not this adapter, records the award; evidence consumption is written by the award transaction.
 * There is no cashier or client input: the customer id is the one the server resolved.
 */
export async function evaluateApprovedQualificationForBadge(db: Db, customerId: string, ruleKey: string): Promise<BadgeQualification | null> {
  const [rule] = await db.select().from(qualificationRuleVersions)
    .where(and(eq(qualificationRuleVersions.ruleKey, ruleKey), eq(qualificationRuleVersions.approvalState, 'approved'), eq(qualificationRuleVersions.participantType, 'customer'))).limit(1);
  if (!rule) return null;
  let spec;
  try { spec = parseQualificationSpec(rule.spec); } catch { return null; }
  const allowedTypes = spec.referralTypes ?? ['customer_referral'];
  const [referral] = await db.select({ id: customerReferrals.id, type: customerReferrals.referralType, attributedAt: customerReferrals.attributedAt })
    .from(customerReferrals).where(eq(customerReferrals.referredCustomerId, customerId)).limit(1);
  const measures: PathwayMeasure[] = [];
  for (const p of spec.pathways) {
    if (p.metric === 'recorded_purchases') {
      measures.push(await measureRecordedPurchases(db, { customerId, pathway: p, ruleVersionId: rule.id, consumerKind: 'badge', since: referral?.attributedAt ?? null }));
    } else {
      measures.push(referral && allowedTypes.includes(referral.type) ? { observed: 1, evidenceIds: [referral.id] } : { observed: 0, evidenceIds: [] });
    }
  }
  const outcome = evaluateQualification(spec, measures);
  if (!outcome.qualified || outcome.evidenceIds.length === 0) return null;
  const referralIds = new Set(referral ? [referral.id] : []);
  return { ruleVersionId: rule.id, specHash: rule.specHash, evidenceIds: outcome.evidenceIds, purchaseEvidenceIds: outcome.evidenceIds.filter((id) => !referralIds.has(id)) };
}

