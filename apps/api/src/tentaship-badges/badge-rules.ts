import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { BadgeParticipantType } from '../db/schema';

/**
 * TB-02: the qualification rule of a Tentaship Badge. DECLARATIVE DATA validated against a CLOSED schema (TSH-01 section 4): a metric from a
 * closed registry, a whole-number threshold and an optional look-back window. No expressions, scripts, regular expressions or free text.
 *
 * Only metrics whose evidence is verified server-side TODAY are implemented. The metrics TSH-01 lists that depend on definitions the Owner
 * has not approved (a verified referral, a qualifying purchase) are REGISTERED AS BLOCKED: a rule using one is refused at creation, so no
 * definition can ever reach `active` on unapproved evidence. Approving a definition later means moving it to the implemented set in a
 * reviewed change; nothing here guesses it.
 */
export const IMPLEMENTED_BADGE_METRICS = {
  /** Customer: count of this customer's Community survey-completion award decisions that are currently `awarded` (reversed ones do not count). */
  community_survey_completions: 'customer',
  /**
   * Customer: the customer satisfies the APPROVED shared qualification rule `ruleKey` (TSH-02 / QUAL-PURCHASE-01), evaluated by the one shared
   * engine from verified server evidence. It is usable ONLY while an approved rule version exists for that key (checked when a definition is
   * created or activated, and again at every evaluation): with none, a badge using it cannot exist, activate or award. Referral-based and
   * purchase-based badges are therefore unavailable until the Owner approves the underlying definitions.
   */
  approved_qualification: 'customer',
  /** Business: count of this business's own Community posts that reached publication and are not suspended by moderation. */
  published_business_posts: 'business',
} as const satisfies Record<string, BadgeParticipantType>;
export type ImplementedBadgeMetric = keyof typeof IMPLEMENTED_BADGE_METRICS;

export const BLOCKED_BADGE_METRICS = {
  verified_customer_referrals: 'A verified referral is not defined or approved (TSH-01 section 5). Business-scoped referral_bonus data is not network referral evidence.',
  verified_business_referrals: 'A verified business referral is not defined or approved (TSH-01 section 5).',
  qualifying_purchases_at_business: 'A qualifying purchase (minimum, settlement window, self-purchase exclusion) is not approved (TSH-01 section 5).',
  distinct_businesses_with_qualifying_purchases: 'A qualifying purchase is not approved (TSH-01 section 5).',
  verified_customers_acquired: 'Verified acquisition is not defined or approved.',
  customer_retention_rate: 'Retention measurement is not defined or approved.',
} as const;

export class BadgeRuleError extends Error {
  constructor(readonly code: 'BADGE_RULE_INVALID' | 'BADGE_METRIC_BLOCKED' | 'BADGE_METRIC_PARTICIPANT_MISMATCH', message: string) {
    super(message);
  }
}

export type BadgeRule = { metric: ImplementedBadgeMetric; threshold: number; windowDays?: number; ruleKey?: string };

const shape = z.object({
  metric: z.string().min(1).max(64),
  threshold: z.number().int().min(1).max(100_000),
  ruleKey: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).optional(),
  windowDays: z.number().int().min(1).max(3650).optional(),
}).strict();

/** Validates a rule for a participant type. Throws BadgeRuleError; never returns an unvalidated value. */
export function parseBadgeRule(raw: unknown, participantType: BadgeParticipantType): BadgeRule {
  const parsed = shape.safeParse(raw);
  if (!parsed.success) throw new BadgeRuleError('BADGE_RULE_INVALID', 'The rule must be {metric, threshold, windowDays?} with whole numbers and no other fields.');
  const { metric, threshold, windowDays, ruleKey } = parsed.data;
  if (Object.hasOwn(BLOCKED_BADGE_METRICS, metric)) {
    throw new BadgeRuleError('BADGE_METRIC_BLOCKED', BLOCKED_BADGE_METRICS[metric as keyof typeof BLOCKED_BADGE_METRICS]);
  }
  if (!Object.hasOwn(IMPLEMENTED_BADGE_METRICS, metric)) throw new BadgeRuleError('BADGE_RULE_INVALID', 'Unknown metric.');
  if (IMPLEMENTED_BADGE_METRICS[metric as ImplementedBadgeMetric] !== participantType) {
    throw new BadgeRuleError('BADGE_METRIC_PARTICIPANT_MISMATCH', 'This metric does not apply to that participant type.');
  }
  if ((metric === 'approved_qualification') !== (ruleKey !== undefined)) throw new BadgeRuleError('BADGE_RULE_INVALID', 'ruleKey belongs to the approved_qualification metric, and that metric needs it.');
  if (metric === 'approved_qualification' && (threshold !== 1 || windowDays !== undefined)) throw new BadgeRuleError('BADGE_RULE_INVALID', 'approved_qualification takes threshold 1 and no window (the shared rule defines them).');
  return { metric: metric as ImplementedBadgeMetric, threshold, ...(windowDays === undefined ? {} : { windowDays }), ...(ruleKey === undefined ? {} : { ruleKey }) };
}

/** Canonical JSON (fixed key order) so the same rule always hashes the same. */
export function canonicalRuleJson(rule: BadgeRule): string {
  return JSON.stringify({ metric: rule.metric, threshold: rule.threshold, ...(rule.windowDays === undefined ? {} : { windowDays: rule.windowDays }), ...(rule.ruleKey === undefined ? {} : { ruleKey: rule.ruleKey }) });
}
export const hashRule = (rule: BadgeRule): string => createHash('sha256').update(canonicalRuleJson(rule)).digest('hex');
