import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { qualificationRuleVersions } from '../db/schema';
import { customerReferrals } from '../db/schema';
import { evaluateQualification, parseQualificationSpec, type PathwayMeasure, type QualificationOutcome } from './qualification-spec';
import { measureRecordedPurchases } from './qualification-evidence';

export type RuleVersionRow = typeof qualificationRuleVersions.$inferSelect;
export type CustomerEvaluation = { outcome: QualificationOutcome; evidenceIds: string[]; purchaseEvidenceIds: string[]; referralId: string | null };

/**
 * The ONE place a qualification spec is evaluated for a customer (Badges, Shuffle and Drops all call it; there is no second engine). It reads server-measured
 * evidence only and takes the customer id the server resolved. The caller decides whether the RULE VERSION is acceptable (approved) BEFORE calling.
 * A spec that no longer parses fails closed (null).
 */
export async function evaluateRuleForCustomer(
  db: Db, customerId: string, rule: RuleVersionRow,
  ctx: { consumerKind: 'referral' | 'badge' | 'campaign'; between?: { start: Date; end: Date } | null },
): Promise<CustomerEvaluation | null> {
  let spec;
  try { spec = parseQualificationSpec(rule.spec); } catch { return null; }
  const allowedTypes = spec.referralTypes ?? ['customer_referral'];
  const [referral] = await db.select({ id: customerReferrals.id, type: customerReferrals.referralType, attributedAt: customerReferrals.attributedAt })
    .from(customerReferrals).where(eq(customerReferrals.referredCustomerId, customerId)).limit(1);
  const measures: PathwayMeasure[] = [];
  for (const p of spec.pathways) {
    if (p.metric === 'recorded_purchases') {
      measures.push(await measureRecordedPurchases(db, { customerId, pathway: p, ruleVersionId: rule.id, consumerKind: ctx.consumerKind, since: referral?.attributedAt ?? null, between: ctx.between ?? null }));
    } else {
      measures.push(referral && allowedTypes.includes(referral.type) ? { observed: 1, evidenceIds: [referral.id] } : { observed: 0, evidenceIds: [] });
    }
  }
  const outcome = evaluateQualification(spec, measures);
  const referralId = referral?.id ?? null;
  return { outcome, evidenceIds: outcome.evidenceIds, purchaseEvidenceIds: outcome.evidenceIds.filter((id) => id !== referralId), referralId };
}
