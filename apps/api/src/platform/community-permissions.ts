import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { PlatformVariables } from '../middleware/require-platform-role';
import { AppError } from '../lib/errors';
import type { PlatformRole } from '../db/schema/users';

export const COMMUNITY_PLATFORM_PERMISSIONS = [
  'community:rules:view',
  'community:rules:manage',
  'community:ledger:view',
  'community:adjust',
] as const;

export type CommunityPlatformPermission =
  (typeof COMMUNITY_PLATFORM_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<PlatformRole, ReadonlySet<CommunityPlatformPermission>> = {
  support: new Set([
    'community:rules:view',
    'community:ledger:view',
  ]),
  billing: new Set([
    'community:rules:view',
    'community:ledger:view',
  ]),
  admin: new Set(COMMUNITY_PLATFORM_PERMISSIONS),
};

export function platformRoleHasCommunityPermission(
  role: PlatformRole,
  permission: CommunityPlatformPermission,
): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Explicit Split 05 platform permission boundary layered on top of
 * requirePlatformRole. These permissions are intentionally code-owned
 * platform authorities and are NOT part of business-scoped roles/permissions.
 */
export function requireCommunityPlatformPermission(
  permission: CommunityPlatformPermission,
) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & PlatformVariables;
  }>(async (c, next) => {
    const role = c.get('platformRole');
    if (!platformRoleHasCommunityPermission(role, permission)) {
      throw new AppError(
        `Missing required platform permission: ${permission}.`,
        403,
        'PLATFORM_PERMISSION_DENIED',
        { requiredPermission: permission, platformRole: role },
      );
    }
    await next();
  });
}
