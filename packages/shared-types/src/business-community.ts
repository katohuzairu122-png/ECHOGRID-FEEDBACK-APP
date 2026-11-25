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
 * participates. Business publishing is not implemented, so it is always 'closed' (BCOMM-03).
 */
export type BusinessCommunityCapabilityState = 'open' | 'closed';
export interface BusinessCommunityStatus {
  /** Whether customers can currently join Community (any enrollment gate is on). Never enrolls anyone by being read. */
  enrollment: BusinessCommunityCapabilityState;
  /** Whether the Community Feed is currently readable. */
  feed: BusinessCommunityCapabilityState;
  /** Business publishing: not implemented, always closed until BCOMM-03. */
  publishing: 'closed';
}
