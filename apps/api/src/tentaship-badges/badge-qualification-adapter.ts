import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { qualificationRuleVersions } from '../db/schema';
import { evaluateRuleForCustomer } from '../qualification/qualification-evaluator';

export type BadgeQualification = { ruleVersionId: string; specHash: string; evidenceIds: string[]; purchaseEvidenceIds: string[] };

/**
 * Tentaship Badges integration with the SHARED qualification engine. Evaluates the APPROVED rule version for `ruleKey` for ONE customer through the
 * single shared evaluator, and fails CLOSED: no approved rule, an invalid spec, or insufficient evidence all return null (no award). The badge ledger,
 * not this adapter, records the award; evidence consumption is written by the award transaction.
 */
export async function evaluateApprovedQualificationForBadge(db: Db, customerId: string, ruleKey: string): Promise<BadgeQualification | null> {
  const [rule] = await db.select().from(qualificationRuleVersions)
    .where(and(eq(qualificationRuleVersions.ruleKey, ruleKey), eq(qualificationRuleVersions.approvalState, 'approved'), eq(qualificationRuleVersions.participantType, 'customer'))).limit(1);
  if (!rule) return null;
  const result = await evaluateRuleForCustomer(db, customerId, rule, { consumerKind: 'badge' });
  if (!result || !result.outcome.qualified || result.evidenceIds.length === 0) return null;
  return { ruleVersionId: rule.id, specHash: rule.specHash, evidenceIds: result.evidenceIds, purchaseEvidenceIds: result.purchaseEvidenceIds };
}
