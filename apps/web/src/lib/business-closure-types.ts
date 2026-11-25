/** BIZ-CLOSE-01 DTOs (mirror apps/api/src/business-closure). Counts only; no customer identity. */
export const CLOSURE_OBLIGATION_KEYS = [
  'pendingRedemptions', 'customerPointBalances', 'customerPointsOutstanding', 'activeMemberships', 'openOrphanRewardClaims',
  'activeSubscriptions', 'activeCashierSessions', 'staffMembers', 'publishedCommunityPosts', 'communityFollowers',
] as const;
export type ClosureObligationKey = (typeof CLOSURE_OBLIGATION_KEYS)[number];

export interface BusinessClosureStatusDto {
  request: { id: string; status: 'pending' | 'cancelled' | 'processed'; requestedAt: string; cancelledAt: string | null } | null;
  eligibility: { processing: 'blocked'; blockers: string[]; obligations: Record<ClosureObligationKey, number> };
}
