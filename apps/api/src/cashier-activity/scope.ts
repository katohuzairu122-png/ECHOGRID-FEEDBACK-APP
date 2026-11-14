import type { Repositories } from '../repositories';

/** Permissions that allow reading cashier activity (Owner/Admin hold audit:view, Manager holds loyalty:accounts:view). */
export const ACTIVITY_VIEW_PERMISSIONS = ['audit:view', 'loyalty:accounts:view'] as const;

export interface ActivityScope {
  /** True when a business-wide grant carries a viewing permission: every branch of the business is visible. */
  all: boolean;
  /** Otherwise: exactly the branches where the user's EFFECTIVE permissions for that branch include a viewing permission. */
  branchIds: string[];
}

type ScopeRepos = Pick<Repositories, 'userBusinessRoles' | 'permissions'>;

const hasView = (keys: Set<string>) => ACTIVITY_VIEW_PERMISSIONS.some((k) => keys.has(k));

/**
 * SEC-CASHIER-R1 (F1): which branches a caller may read cashier activity for, decided per branch.
 *
 * The earlier rule checked the permission for ONE branch (the X-Branch-Id header) and then granted every branch the
 * user holds any role at, so a Manager at branch A who is only Staff at branch B could read branch B by sending A's
 * header. Here each branch stands on its own: a branch is visible only if the user's effective permissions FOR THAT
 * BRANCH (business-wide grants plus grants at that branch) include a viewing permission. A viewing permission held
 * only at branch A is never counted for branch B, and a business-wide viewing permission is the only thing that makes
 * every branch visible.
 */
export async function resolveActivityScope(
  repos: ScopeRepos,
  userId: string,
  businessId: string,
): Promise<ActivityScope> {
  const businessWide = await repos.permissions.findEffectiveKeys(userId, businessId);
  if (hasView(businessWide)) return { all: true, branchIds: [] };

  const grants = await repos.userBusinessRoles.listForUserAtBusiness(userId, businessId);
  const granted = [...new Set(grants.flatMap((g) => (g.branchId ? [g.branchId] : [])))];
  const visible: string[] = [];
  for (const branchId of granted) {
    if (hasView(await repos.permissions.findEffectiveKeys(userId, businessId, branchId))) visible.push(branchId);
  }
  return { all: false, branchIds: visible };
}
