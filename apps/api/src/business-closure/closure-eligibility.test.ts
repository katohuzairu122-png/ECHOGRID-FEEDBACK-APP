import { describe, expect, it } from 'vitest';
import { confirmationMatches, emptyObligations, evaluateClosureEligibility } from './closure-eligibility';

describe('BIZ-CLOSE-01 eligibility', () => {
  it('is ALWAYS blocked: no approved closure policy exists, even for a business with no obligations', () => {
    const e = evaluateClosureEligibility(emptyObligations());
    expect(e.processing).toBe('blocked');
    expect(e.blockers).toEqual(['CLOSURE_POLICY_NOT_APPROVED']);
  });

  it('adds one blocker per kind of outstanding obligation', () => {
    const o = { ...emptyObligations(), pendingRedemptions: 2, customerPointsOutstanding: 50, openOrphanRewardClaims: 1, activeSubscriptions: 1, activeCashierSessions: 3, publishedCommunityPosts: 4 };
    expect(evaluateClosureEligibility(o).blockers).toEqual([
      'CLOSURE_POLICY_NOT_APPROVED', 'PENDING_REDEMPTIONS', 'CUSTOMER_POINTS_OUTSTANDING', 'OPEN_REWARD_CLAIMS',
      'ACTIVE_SUBSCRIPTION', 'ACTIVE_CASHIER_SESSIONS', 'COMMUNITY_CONTENT_PUBLISHED',
    ]);
  });

  it('G9: Tentaship obligations (active sponsorships, units awaiting collection, open governance cases) are blockers; no resolution policy is invented', () => {
    const o = { ...emptyObligations(), activeSponsorships: 1, unitsAwaitingCollection: 2, openGovernanceCases: 1 };
    expect(evaluateClosureEligibility(o).blockers).toEqual(['CLOSURE_POLICY_NOT_APPROVED', 'ACTIVE_SPONSORSHIPS', 'UNITS_AWAITING_COLLECTION', 'OPEN_GOVERNANCE_CASES']);
    expect(evaluateClosureEligibility(o).processing).toBe('blocked');
  });

  it('informational counts (members, staff, followers, balances) are reported but are not blockers on their own', () => {
    const o = { ...emptyObligations(), activeMemberships: 9, staffMembers: 3, communityFollowers: 7, customerPointBalances: 4 };
    expect(evaluateClosureEligibility(o).blockers).toEqual(['CLOSURE_POLICY_NOT_APPROVED']);
  });

  it('the typed confirmation must equal the business name (outer whitespace ignored, case and content exact, never empty)', () => {
    expect(confirmationMatches('Echo Cafe', ' Echo Cafe ')).toBe(true);
    expect(confirmationMatches('Echo Cafe', 'echo cafe')).toBe(false);
    expect(confirmationMatches('Echo Cafe', 'Echo')).toBe(false);
    expect(confirmationMatches('', '')).toBe(false);
    expect(confirmationMatches('Echo Cafe', '   ')).toBe(false);
  });
});
