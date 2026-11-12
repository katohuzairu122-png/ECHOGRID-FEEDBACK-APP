/**
 * D-C1: dedicated cashier permissions and the pure planning logic that reconciles existing role grants.
 *
 * `loyalty:manage` and `loyalty:view` used to cover both front-counter service and business-wide
 * administration, so the default Staff role could call administrative routes (account directory, tiers,
 * feedback, messaging) even though the cashier UI hides them. This module defines the narrower
 * permissions and the evidence-based rules for moving existing roles onto them.
 *
 * Everything here is pure (no database access) so the rules can be tested exhaustively. The script
 * `db/seed/loyalty-permissions-reconcile.seed.ts` applies a plan; nothing runs automatically.
 */

/** Verified QR customer service: resolve a signed customer QR, record a purchase, review and confirm a redemption. */
export const LOYALTY_SERVE = 'loyalty:serve';
/** Business-wide loyalty account directory, account detail and transaction history. */
export const LOYALTY_ACCOUNTS_VIEW = 'loyalty:accounts:view';
/** Manual balance adjustments. */
export const LOYALTY_ADJUST = 'loyalty:adjust';

export const NEW_LOYALTY_PERMISSIONS = [
  LOYALTY_SERVE,
  LOYALTY_ACCOUNTS_VIEW,
  LOYALTY_ADJUST,
] as const;

/** Legacy permissions that, together, made default Staff over-privileged. Not removed from the catalog. */
export const LEGACY_STAFF_EXPOSURE = [
  'loyalty:view',
  'loyalty:manage',
  'feedback:view',
  'messages:view',
  'messages:send',
] as const;

/** The exact default grant set RoleProvisioningService gave the Staff role before D-C1 (historical evidence). */
export const HISTORICAL_STAFF_DEFAULT: readonly string[] = [
  'business:view',
  'branches:view',
  'feedback:view',
  'loyalty:view',
  'loyalty:manage',
  'messages:view',
  'messages:send',
];

/** The least-privilege Staff (cashier) default after D-C1. */
export const STAFF_DEFAULT: readonly string[] = ['business:view', 'branches:view', LOYALTY_SERVE];

export interface RoleSnapshot {
  roleId: string;
  businessId: string;
  name: string;
  isSystem: boolean;
  keys: ReadonlySet<string>;
}

export type Classification =
  /** A system Staff role whose grants are a subset of the historical default: provably never customised upward. */
  | 'default_staff'
  /** Every other role: Owner, Admin, Manager or any custom or renamed role. Never reduced automatically. */
  | 'preserved';

export interface PlanAction {
  roleId: string;
  businessId: string;
  roleName: string;
  classification: Classification;
  grant: string[];
  revoke: string[];
  /** Roles that still hold legacy exposure and need an owner decision (never changed by this plan). */
  needsOwnerDecision: string[];
}

export function classifyRole(role: RoleSnapshot): Classification {
  // loyalty:serve is allowed too: it is what phase A adds to an unmodified default Staff role.
  const isSubsetOfDefault = [...role.keys].every(
    (key) => HISTORICAL_STAFF_DEFAULT.includes(key) || key === LOYALTY_SERVE,
  );
  return role.isSystem && role.name === 'Staff' && isSubsetOfDefault
    ? 'default_staff'
    : 'preserved';
}

/**
 * Phase A (additive, safe BEFORE the new API is deployed): grant the new permissions to roles that held the
 * authority they replace, so nobody loses a capability they legitimately had.
 *   loyalty:serve          <- loyalty:manage
 *   loyalty:adjust         <- loyalty:manage AND rewards:manage (the pre-D-C1 adjustment requirement)
 *   loyalty:accounts:view  <- loyalty:view, EXCEPT on a default Staff role (that exposure is the defect)
 * Only adds; never removes. Idempotent: keys already held are skipped.
 */
export function planAdditive(roles: readonly RoleSnapshot[]): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const role of roles) {
    const classification = classifyRole(role);
    const wanted = new Set<string>();
    if (role.keys.has('loyalty:manage')) wanted.add(LOYALTY_SERVE);
    if (role.keys.has('loyalty:manage') && role.keys.has('rewards:manage'))
      wanted.add(LOYALTY_ADJUST);
    if (role.keys.has('loyalty:view') && classification !== 'default_staff')
      wanted.add(LOYALTY_ACCOUNTS_VIEW);
    const grant = [...wanted].filter((key) => !role.keys.has(key)).sort();
    // A role that could resolve a QR and look up redemptions through loyalty:view alone, without ever being
    // able to record a purchase, does NOT gain loyalty:serve (that would be a new capability). It loses those
    // two counter operations, which is the intended narrowing; it is reported so the owner can see every role affected.
    const needsOwnerDecision =
      role.keys.has('loyalty:view') &&
      !role.keys.has('loyalty:manage') &&
      !role.keys.has(LOYALTY_SERVE)
        ? ['loses QR resolve and redemption lookup (held loyalty:view without loyalty:manage)']
        : [];
    if (grant.length > 0 || needsOwnerDecision.length > 0) {
      actions.push({
        roleId: role.roleId,
        businessId: role.businessId,
        roleName: role.name,
        classification,
        grant,
        revoke: [],
        needsOwnerDecision,
      });
    }
  }
  return actions;
}

/**
 * Phase B (reducing, run only AFTER the new API is deployed): remove the legacy exposure from default Staff
 * roles. A role is reduced only if it is provably an unmodified default (classifyRole) AND already holds
 * loyalty:serve, so a cashier is never stranded without service access. Custom, renamed and administrative
 * roles are never reduced; those still holding legacy exposure are reported for an owner decision.
 */
export function planReduce(roles: readonly RoleSnapshot[]): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const role of roles) {
    const classification = classifyRole(role);
    if (classification === 'default_staff') {
      if (!role.keys.has(LOYALTY_SERVE)) continue; // phase A has not run for this role: do nothing
      const revoke = LEGACY_STAFF_EXPOSURE.filter((key) => role.keys.has(key)).sort();
      if (revoke.length > 0) {
        actions.push({
          roleId: role.roleId,
          businessId: role.businessId,
          roleName: role.name,
          classification,
          grant: [],
          revoke: [...revoke],
          needsOwnerDecision: [],
        });
      }
      continue;
    }
    const exposure = LEGACY_STAFF_EXPOSURE.filter((key) => role.keys.has(key));
    const isAdministrative =
      role.keys.has('rewards:manage') ||
      role.keys.has('team:view') ||
      role.keys.has('analytics:view');
    if (exposure.length > 0 && !isAdministrative) {
      // A custom, renamed or extended non-administrative role still holding legacy exposure: it may have been
      // granted on purpose, so it is reported and never changed automatically. The owner decides.
      actions.push({
        roleId: role.roleId,
        businessId: role.businessId,
        roleName: role.name,
        classification,
        grant: [],
        revoke: [],
        needsOwnerDecision: [...exposure],
      });
    }
  }
  return actions;
}
