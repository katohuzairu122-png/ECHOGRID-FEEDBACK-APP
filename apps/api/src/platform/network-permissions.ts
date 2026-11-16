import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { PlatformVariables } from '../middleware/require-platform-role';
import { AppError } from '../lib/errors';
import type { PlatformRole } from '../db/schema/users';

/**
 * NETWORK-01 platform authorities. Code-owned (NETWORK-00 section 5), NOT business-scoped roles: only the platform
 * `admin` role holds either, `support` and `billing` hold neither, and a business role can never obtain them. Publishing
 * also needs TWO distinct admins (author plus two approvers), so one admin alone can never publish.
 */
export const NETWORK_PLATFORM_PERMISSIONS = ['network:author', 'network:moderate'] as const;
export type NetworkPlatformPermission = (typeof NETWORK_PLATFORM_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<PlatformRole, ReadonlySet<NetworkPlatformPermission>> = {
  support: new Set(),
  billing: new Set(),
  admin: new Set(NETWORK_PLATFORM_PERMISSIONS),
};

export function platformRoleHasNetworkPermission(role: PlatformRole, permission: NetworkPlatformPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function requireNetworkPlatformPermission(permission: NetworkPlatformPermission) {
  return createMiddleware<{ Bindings: Bindings; Variables: AuthVariables & PlatformVariables }>(async (c, next) => {
    if (!platformRoleHasNetworkPermission(c.get('platformRole'), permission)) {
      throw new AppError(`Missing required platform permission: ${permission}.`, 403, 'PLATFORM_PERMISSION_DENIED', {
        requiredPermission: permission,
      });
    }
    await next();
  });
}
