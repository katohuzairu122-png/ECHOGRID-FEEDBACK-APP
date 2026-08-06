import type { Repositories } from '../repositories';

/**
 * Starter roles seeded for every new business, each with a sensible default
 * permission set. Businesses can rename, delete, or add to their own copies
 * afterward -- these are day-one defaults, not fixed system rows (see
 * schema comment on roles.ts for why there is no shared/global role
 * concept). Owner is the only role that can delete the business.
 */
const DEFAULT_ROLES: Record<string, string[]> = {
  Owner: [
    'team:invite',
    'team:remove',
    'team:view',
    'roles:manage',
    'roles:view',
    'business:view',
    'business:manage_settings',
    'business:delete',
    'branches:view',
    'branches:manage',
    'audit:view',
    'feedback:view',
    'feedback:manage',
    'loyalty:view',
    'loyalty:manage',
    'rewards:manage',
    'analytics:view',
    'analytics:manage',
    'notifications:view',
    'notifications:manage',
    'billing:view',
    'billing:manage',
    'messages:view',
    'messages:send',
  ],
  // Admin mirrors Owner for everything EXCEPT the two irreversible,
  // financially-consequential actions: deleting the business and managing
  // its subscription (changing plan, canceling, updating payment method).
  // billing:view still included -- Admin can see what the business is
  // paying, just not change it. Same deliberate cut as business:delete's
  // existing Owner-only precedent, applied consistently to billing:manage.
  Admin: [
    'team:invite',
    'team:remove',
    'team:view',
    'roles:manage',
    'roles:view',
    'business:view',
    'business:manage_settings',
    'branches:view',
    'branches:manage',
    'audit:view',
    'feedback:view',
    'feedback:manage',
    'loyalty:view',
    'loyalty:manage',
    'rewards:manage',
    'analytics:view',
    'analytics:manage',
    'notifications:view',
    'notifications:manage',
    'billing:view',
    'messages:view',
    'messages:send',
  ],
  Manager: [
    'team:view',
    'roles:view',
    'business:view',
    'branches:view',
    'branches:manage',
    'feedback:view',
    'feedback:manage',
    'loyalty:view',
    'loyalty:manage',
    'rewards:manage',
    'analytics:view',
    'analytics:manage',
    'notifications:view',
    'notifications:manage',
    'messages:view',
    'messages:send',
  ],
  // Staff can see feedback about their own branch's service (day-to-day
  // context) but not triage it -- marking reviewed / removing a submission
  // reads as a supervisory action, consistent with Staff being view-only
  // everywhere else in this table. Loyalty is different: recording a
  // purchase/check-in and confirming a redemption are literally front-counter
  // tasks, so Staff gets loyalty:manage too -- but NOT rewards:manage, which
  // is program configuration (point costs, tiers) and a real fraud vector if
  // left open to front-line staff. Analytics gets neither key at all --
  // trend/summary data is business-strategy information, not a front-counter
  // task, so it stays out of Staff's default entirely (a stricter cut than
  // even feedback:manage, which Staff is merely denied, not omitted from
  // context around). Notifications' business-wide settings (kill switches,
  // SMS cap) follow the same cut as rewards:manage -- program-level
  // configuration with real cost/noise consequences, not a front-counter
  // task. This is separate from a Staff member managing their OWN
  // notification preferences, which needs no permission at all (self-service,
  // same reasoning as a customer managing their own loyalty account) --
  // notifications:view/:manage gate the business-wide settings screen only.
  // Messaging follows loyalty:manage's cut, not rewards:manage's: replying
  // to a customer about their visit is a front-counter task, not program
  // configuration. No separate 'messages:manage' concept exists (unlike
  // rewards) because there's no comparable fraud/cost surface to gate --
  // every role that can see a conversation can also send in it.
  Staff: [
    'business:view',
    'branches:view',
    'feedback:view',
    'loyalty:view',
    'loyalty:manage',
    'messages:view',
    'messages:send',
  ],
};

/**
 * Not transactional itself -- composable with whatever repositories the
 * caller passes in (plain or transaction-scoped). BusinessService is
 * currently the only caller, and it owns the transaction spanning business
 * creation + this + the owner grant.
 */
export class RoleProvisioningService {
  constructor(private readonly repos: Pick<Repositories, 'roles' | 'permissions'>) {}

  /** Returns a map of role name -> role id, so the caller can grant one
   * (typically Owner) to the business's creator. */
  async seedDefaultRoles(businessId: string, createdBy: string): Promise<Record<string, string>> {
    const roleIds: Record<string, string> = {};

    // Loaded once and reused across all 4 roles -- looking each key up
    // individually (as this used to) means a DB round trip per permission
    // per role (~120+ sequential awaits total), which is fine against an
    // empty/unseeded catalog (every lookup is a fast miss) but becomes slow
    // enough to blow past request timeouts once the catalog is actually
    // populated, since every one of those becomes a real write too.
    const catalog = await this.repos.permissions.listAll();
    const permissionIdByKey = new Map(catalog.map((p) => [p.key, p.id]));

    for (const [name, permissionKeys] of Object.entries(DEFAULT_ROLES)) {
      const role = await this.repos.roles.create({ businessId, name, isSystem: true, createdBy });
      roleIds[name] = role.id;

      // Keys with no matching catalog row (pnpm db:seed not yet run for
      // them) are skipped rather than failing business creation; the role
      // just starts with fewer permissions than intended until the catalog
      // catches up.
      const permissionIds = permissionKeys
        .map((key) => permissionIdByKey.get(key))
        .filter((id): id is string => id !== undefined);
      await this.repos.permissions.assignManyToRole(role.id, permissionIds);
    }

    return roleIds;
  }
}
