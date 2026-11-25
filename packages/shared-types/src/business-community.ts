/**
 * BCOMM-01: the business Community hub contract, shared by the API and the web app so the two cannot drift.
 *
 * COMMUNITY_HUB_PERMISSIONS: a business user may open the Community hub only when they hold at least one of these existing
 * permissions, i.e. they MANAGE the business (owner, admin, manager). Counter staff (cashier) and view-only staff hold none of them.
 * No new permission is introduced; navigation visibility is never the only check (the API route enforces the same list).
 */
export const COMMUNITY_HUB_PERMISSIONS = [
  'business:manage_settings',
  'analytics:view',
  'loyalty:accounts:view',
  'rewards:manage',
  'feedback:manage',
  'team:view',
] as const;

export function holdsCommunityHubPermission(permissions: ReadonlySet<string> | readonly string[]): boolean {
  const has = (key: string) => (permissions instanceof Set ? permissions.has(key) : (permissions as readonly string[]).includes(key));
  return COMMUNITY_HUB_PERMISSIONS.some(has);
}

/**
 * The rollout state a business may see. Coarse and read-only: it reports whether each capability is currently open, never who
 * participates. Publishing and distribution report their own server controls (BCOMM-03/04).
 */
export type BusinessCommunityCapabilityState = 'open' | 'closed';
export interface BusinessCommunityStatus {
  /** Whether customers can currently join Community (any enrollment gate is on). Never enrolls anyone by being read. */
  enrollment: BusinessCommunityCapabilityState;
  /** Whether the Community Feed is currently readable. */
  feed: BusinessCommunityCapabilityState;
  /** Business publishing (authoring and submission), controlled server-side by NETWORK_BUSINESS_PUBLISHING_ENABLED. */
  publishing: BusinessCommunityCapabilityState;
  /** Whether approved business posts reach customers: needs the distribution control AND the Feed (BCOMM-04). */
  distribution: BusinessCommunityCapabilityState;
}

/**
 * BCOMM-02: privacy-protected participation totals for ONE business. A figure is either shown or suppressed (a small group is never disclosed),
 * and nothing identifies a customer. Suppression is decided by the server; the client only renders what it is given.
 */
export type CommunityFigure = { state: 'shown'; value: number } | { state: 'suppressed' };

export interface BusinessCommunityParticipation {
  /** The smallest group the server will disclose (never below COMMUNITY_AGGREGATE_MIN_GROUP_SIZE_FLOOR). */
  minimumGroupSize: number;
  /** The business's active loyalty customers. */
  eligible: CommunityFigure;
  /** Of those, the customers who currently hold an active Community membership. */
  participants: CommunityFigure;
  /** participants / eligible as a whole percentage; shown only when both figures are shown. */
  ratePercent: CommunityFigure;
}

export const COMMUNITY_AGGREGATE_MIN_GROUP_SIZE_FLOOR = 10;
