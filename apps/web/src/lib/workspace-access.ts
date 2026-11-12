export interface MyAccess {
  /** Effective permissions for the active business; empty when they could not be read. */
  permissions: ReadonlySet<string>;
  /** True only when the read succeeded, so a failure is never mistaken for "no permissions". */
  known: boolean;
}

export type WorkspaceKind = 'cashier' | 'management' | 'unavailable';

/**
 * Permissions that mean "manages the business" rather than "serves customers at the counter". A user who
 * holds none of them and can record loyalty activity is counter staff. View-level permissions that the
 * default Staff role carries (business, branches, feedback, messages, loyalty:view) are deliberately NOT in
 * this list: they do not make anyone a manager.
 */
export const MANAGEMENT_PERMISSIONS: readonly string[] = [
  'rewards:manage',
  'loyalty:accounts:view',
  'loyalty:adjust',
  'analytics:view',
  'analytics:manage',
  'team:view',
  'team:invite',
  'team:remove',
  'roles:view',
  'roles:manage',
  'business:manage_settings',
  'business:delete',
  'branches:manage',
  'feedback:manage',
  'survey:manage',
  'notifications:view',
  'notifications:manage',
  'billing:view',
  'billing:manage',
  'audit:view',
];

/**
 * Classifies by EFFECTIVE permissions only (never by a role's display name). Unknown, failed or stale
 * permission reads classify as 'unavailable' and never as cashier, manager or owner.
 */
export function classifyWorkspace(access: MyAccess): WorkspaceKind {
  if (!access.known) return 'unavailable';
  const holdsManagement = MANAGEMENT_PERMISSIONS.some((p) => access.permissions.has(p));
  // loyalty:serve is the D-C1 cashier permission. Legacy loyalty:manage still counts for the presentation of
  // roles that were not reconciled yet; the API (which needs loyalty:serve) remains the authority.
  const serves =
    access.permissions.has('loyalty:serve') || access.permissions.has('loyalty:manage');
  if (!holdsManagement && serves) return 'cashier';
  return 'management';
}

export function isCounterStaff(access: MyAccess): boolean {
  return classifyWorkspace(access) === 'cashier';
}

/** Programme configuration (tiers, rewards, manual adjustment): requires rewards:manage. Fails closed. */
export function canConfigureProgramme(access: MyAccess): boolean {
  return access.known && access.permissions.has('rewards:manage');
}
