import type { Repositories } from '../repositories';

/**
 * Starter roles seeded for every new business, each with a sensible default
 * permission set. Businesses can rename, delete, or add to their own copies
 * afterward -- these are day-one defaults, not fixed system rows (see
 * schema comment on roles.ts for why there is no shared/global role
 * concept). Owner is the only role that can delete the business.
 */
/**
 * The four role names seeded for every business, as a tuple so the type
 * below is derived from it rather than restated.
 *
 * WHY THIS IS EXPORTED AND TYPED (audit P3-6)
 * DEFAULT_ROLES used to be `Record<string, string[]>`, which widened the
 * KEY type to `string`. That made seedDefaultRoles return
 * `Record<string, string>`, so `roleIds.Owner` was `string | undefined` for
 * every caller, and each one had to guard a lookup that cannot actually
 * miss. Three integration suites simply did not guard -- invisible until
 * tsconfig.test.json first typechecked them, and latent: had the seed ever
 * failed to create a role, those suites would have inserted `undefined` as
 * a foreign key and reported a confusing database error instead of a clear
 * "role was not provisioned".
 *
 * Narrowing the key type is a strictly narrower return type, so existing
 * callers keep typechecking. BusinessService's runtime `if (!ownerRoleId)`
 * guard is deliberately KEPT: the accumulator below is built with a type
 * assertion, and a runtime backstop on a foreign key is worth more than the
 * two lines it costs.
 */
export const DEFAULT_ROLE_NAMES = ['Owner', 'Admin', 'Manager', 'Staff'] as const;
export type DefaultRoleName = (typeof DEFAULT_ROLE_NAMES)[number];

const DEFAULT_ROLES: Record<DefaultRoleName, string[]> = {
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
    'survey:view',
    'survey:manage',
    'survey:responses:view',
    'loyalty:view',
    'loyalty:manage',
    'rewards:manage',
    'loyalty:serve',
    'loyalty:accounts:view',
    'loyalty:adjust',
    'analytics:view',
    'analytics:manage',
    'notifications:view',
    'notifications:manage',
    'billing:view',
    'billing:manage',
    'settlement:view',
    'settlement:accept',
    'settlement:fulfill',
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
    'survey:view',
    'survey:manage',
    'survey:responses:view',
    'loyalty:view',
    'loyalty:manage',
    'rewards:manage',
    'loyalty:serve',
    'loyalty:accounts:view',
    'loyalty:adjust',
    'analytics:view',
    'analytics:manage',
    'notifications:view',
    'notifications:manage',
    'billing:view',
    'settlement:view',
    'settlement:accept',
    'settlement:fulfill',
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
    'survey:view',
    'survey:manage',
    'survey:responses:view',
    'loyalty:view',
    'loyalty:manage',
    'rewards:manage',
    'loyalty:serve',
    'loyalty:accounts:view',
    'loyalty:adjust',
    'analytics:view',
    'analytics:manage',
    'notifications:view',
    'notifications:manage',
    'settlement:view',
    'settlement:accept',
    'settlement:fulfill',
    'messages:view',
    'messages:send',
  ],
  // Staff is the front-counter (cashier) role and is deliberately minimal (D-C1):
  // verified QR service through loyalty:serve (resolve a signed customer QR,
  // record a purchase, review and confirm a redemption) plus the two view keys
  // the cashier workspace needs. It does NOT hold loyalty:view, loyalty:manage,
  // loyalty:accounts:view, loyalty:adjust, rewards:manage, feedback:* or
  // messages:*, so it cannot browse the account directory, read feedback or
  // conversations, configure the programme or adjust balances, whatever the UI
  // shows. Before D-C1 it also held loyalty:view, loyalty:manage, feedback:view,
  // messages:view and messages:send; existing businesses are reconciled by
  // db/seed/loyalty-permissions-reconcile.seed.ts under a separate gate.
  Staff: ['business:view', 'branches:view', 'loyalty:serve'],
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
   * (typically Owner) to the business's creator. Keyed by DefaultRoleName
   * rather than `string`, so `roleIds.Owner` is a `string` and not a
   * maybe-missing lookup every caller has to re-guard. */
  async seedDefaultRoles(businessId: string, createdBy: string): Promise<Record<DefaultRoleName, string>> {
    // Assertion justified by the loop below iterating DEFAULT_ROLE_NAMES
    // exhaustively -- every key is assigned before this is returned.
    const roleIds = {} as Record<DefaultRoleName, string>;

    // Loaded once and reused across all 4 roles -- looking each key up
    // individually (as this used to) means a DB round trip per permission
    // per role (~120+ sequential awaits total), which is fine against an
    // empty/unseeded catalog (every lookup is a fast miss) but becomes slow
    // enough to blow past request timeouts once the catalog is actually
    // populated, since every one of those becomes a real write too.
    const catalog = await this.repos.permissions.listAll();
    const permissionIdByKey = new Map(catalog.map((p) => [p.key, p.id]));

    // Iterates the tuple, not Object.entries, so TypeScript can see every
    // key of the returned record is populated. Same order, same behaviour.
    for (const name of DEFAULT_ROLE_NAMES) {
      const permissionKeys = DEFAULT_ROLES[name];
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
