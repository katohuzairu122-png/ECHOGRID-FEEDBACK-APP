import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { PlatformVariables } from '../middleware/require-platform-role';
import { AppError } from '../lib/errors';
import type { PlatformRole } from '../db/schema/users';

/**
 * BDPN-01B part 2 (decision D-03): the platform authority to review business public profiles. Code-owned, NOT stored in
 * the database and NOT a business-scoped role: only the platform `admin` role holds it, `support` and `billing` hold
 * nothing, and no business role can ever obtain it. The business-side keys (`profile:edit`, `profile:submit`) live in the
 * permission catalog instead, because they are granted to business roles.
 *
 * This module only decides WHO may moderate. Separation of duties (the reviewer is never the submitter, and optionally
 * never holds a role in the reviewed business, open question O-B2) is enforced where the review happens, not here, and
 * the database already refuses `reviewed_by = submitted_by`.
 */
export const PROFILE_PLATFORM_PERMISSIONS = ['profile:moderate'] as const;
export type ProfilePlatformPermission = (typeof PROFILE_PLATFORM_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<PlatformRole, ReadonlySet<ProfilePlatformPermission>> = {
  support: new Set(),
  billing: new Set(),
  admin: new Set(PROFILE_PLATFORM_PERMISSIONS),
};

/** An unknown, missing or tampered role holds nothing: the check fails closed with a plain denial, never an error. */
export function platformRoleHasProfilePermission(role: PlatformRole | undefined, permission: ProfilePlatformPermission): boolean {
  return (role !== undefined && ROLE_PERMISSIONS[role]?.has(permission)) === true;
}

export function requireProfilePlatformPermission(permission: ProfilePlatformPermission) {
  return createMiddleware<{ Bindings: Bindings; Variables: AuthVariables & PlatformVariables }>(async (c, next) => {
    if (!platformRoleHasProfilePermission(c.get('platformRole'), permission)) {
      throw new AppError(`Missing required platform permission: ${permission}.`, 403, 'PLATFORM_PERMISSION_DENIED', {
        requiredPermission: permission,
      });
    }
    await next();
  });
}
