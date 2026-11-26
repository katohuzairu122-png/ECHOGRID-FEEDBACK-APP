/**
 * BIZ-CLOSE-01: pure evaluation of what stands between a closure REQUEST and any closure PROCESSING. No I/O, so every rule is unit-testable.
 *
 * Processing is never available in this block. Settlement, forfeiture, refund and legally required retention rules are NOT approved
 * policy and are deliberately not invented here, so the evaluation always reports CLOSURE_POLICY_NOT_APPROVED as a blocker, and adds one
 * blocker per kind of outstanding obligation that a processing policy would have to resolve. The state is therefore `blocked` until the
 * Owner approves the missing policy and a later, separately authorised block implements processing.
 */
export const CLOSURE_OBLIGATION_KEYS = [
  'pendingRedemptions',
  'customerPointBalances',
  'customerPointsOutstanding',
  'activeMemberships',
  'openOrphanRewardClaims',
  'activeSubscriptions',
  'activeCashierSessions',
  'staffMembers',
  'publishedCommunityPosts',
  'communityFollowers',
  // G9 Tentaship obligations (counts only; no policy for their resolution is invented)
  'activeSponsorships',
  'unitsAwaitingCollection',
  'openGovernanceCases',
] as const;
export type ClosureObligationKey = (typeof CLOSURE_OBLIGATION_KEYS)[number];
export type ClosureObligations = Record<ClosureObligationKey, number>;

export const CLOSURE_BLOCKER_CODES = [
  'CLOSURE_POLICY_NOT_APPROVED',
  'PENDING_REDEMPTIONS',
  'CUSTOMER_POINTS_OUTSTANDING',
  'OPEN_REWARD_CLAIMS',
  'ACTIVE_SUBSCRIPTION',
  'ACTIVE_CASHIER_SESSIONS',
  'COMMUNITY_CONTENT_PUBLISHED',
  'ACTIVE_SPONSORSHIPS',
  'UNITS_AWAITING_COLLECTION',
  'OPEN_GOVERNANCE_CASES',
] as const;
export type ClosureBlockerCode = (typeof CLOSURE_BLOCKER_CODES)[number];

export type ClosureEligibility = {
  /** Always `blocked` in this block: nothing can process a closure. */
  processing: 'blocked';
  blockers: ClosureBlockerCode[];
  obligations: ClosureObligations;
};

export const emptyObligations = (): ClosureObligations =>
  Object.fromEntries(CLOSURE_OBLIGATION_KEYS.map((k) => [k, 0])) as ClosureObligations;

export function evaluateClosureEligibility(obligations: ClosureObligations): ClosureEligibility {
  const blockers: ClosureBlockerCode[] = ['CLOSURE_POLICY_NOT_APPROVED'];
  if (obligations.pendingRedemptions > 0) blockers.push('PENDING_REDEMPTIONS');
  if (obligations.customerPointsOutstanding > 0) blockers.push('CUSTOMER_POINTS_OUTSTANDING');
  if (obligations.openOrphanRewardClaims > 0) blockers.push('OPEN_REWARD_CLAIMS');
  if (obligations.activeSubscriptions > 0) blockers.push('ACTIVE_SUBSCRIPTION');
  if (obligations.activeCashierSessions > 0) blockers.push('ACTIVE_CASHIER_SESSIONS');
  if (obligations.publishedCommunityPosts > 0) blockers.push('COMMUNITY_CONTENT_PUBLISHED');
  if (obligations.activeSponsorships > 0) blockers.push('ACTIVE_SPONSORSHIPS');
  if (obligations.unitsAwaitingCollection > 0) blockers.push('UNITS_AWAITING_COLLECTION');
  if (obligations.openGovernanceCases > 0) blockers.push('OPEN_GOVERNANCE_CASES');
  return { processing: 'blocked', blockers, obligations };
}

/** The typed confirmation must equal the business name (surrounding whitespace ignored, otherwise exact). */
export function confirmationMatches(businessName: string, typed: string): boolean {
  return typed.trim().length > 0 && typed.trim() === businessName.trim();
}
