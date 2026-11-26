/**
 * G6 PROPOSED Tentaship permission definitions (TSH-01 section 9). They are DEFINITIONS ONLY: none is in the live permission catalogue (permissions.seed), none is granted to any role,
 * and none is on the cashier allow-list. Adding any of them to the catalogue, a role or a route is a separate Owner-approved change. `cashierAllowListed` is a recorded fact that a test
 * keeps false, not a switch.
 */
export interface ProposedPermission { key: string; description: string; audience: 'platform' | 'sponsor' | 'business_staff'; cashierAllowListed: false; status: 'proposed' }

export const PROPOSED_TENTASHIP_PERMISSIONS: readonly ProposedPermission[] = [
  { key: 'shuffle:campaign:administer', description: 'Configure Shuffle campaigns.', audience: 'platform', cashierAllowListed: false, status: 'proposed' },
  { key: 'shuffle:campaign:suspend', description: 'Suspend a Shuffle campaign.', audience: 'platform', cashierAllowListed: false, status: 'proposed' },
  { key: 'shuffle:qualification:verify', description: 'Verify qualification evidence.', audience: 'platform', cashierAllowListed: false, status: 'proposed' },
  { key: 'shuffle:fraud:investigate', description: 'Investigate fraud cases (assigned operators only).', audience: 'platform', cashierAllowListed: false, status: 'proposed' },
  { key: 'shuffle:dispute:resolve', description: 'Resolve disputes (assigned operators only).', audience: 'platform', cashierAllowListed: false, status: 'proposed' },
  { key: 'drops:sponsorship:approve', description: 'Approve a Drops sponsorship (never the sponsor).', audience: 'platform', cashierAllowListed: false, status: 'proposed' },
  { key: 'drops:inventory:manage', description: 'Sponsor manages its own drops only.', audience: 'sponsor', cashierAllowListed: false, status: 'proposed' },
  { key: 'drops:fulfillment:verify', description: 'Business staff verify a collection at the collection point (the only Tentaship permission a cashier could ever hold).', audience: 'business_staff', cashierAllowListed: false, status: 'proposed' },
] as const;

/** External sponsor analytics is UNAVAILABLE until the Owner approves a privacy-threshold policy and a sponsor permission; this evaluation is therefore always a refusal today. */
export function evaluateExternalSponsorAnalyticsAccess(): { allowed: false; reason: string; requires: readonly string[] } {
  return { allowed: false, reason: 'EXTERNAL_SPONSOR_ANALYTICS_UNAVAILABLE', requires: ['approved privacy-threshold policy', 'approved sponsor analytics permission', 'approved sponsor route'] };
}
