import { AppError } from '../lib/errors';

/**
 * Fail closed when authorization guards are accidentally mounted without
 * authenticate + resolveTenantContext, or when a partial context is supplied.
 * The middleware chain supplies these values from trusted database-backed
 * checks; this helper does NOT replace membership or permission resolution.
 */
// DEV-83: authorization context must never contain malformed/ambiguous
// identity selectors even when an upstream middleware is mis-mounted.
// Keep the legacy fixture identifier alphabet accepted by tenant-context.
const isSafeIdentity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);

// DEV-84: a Set with untrusted entries is not a trustworthy permission set.
// Preserve the existing vocabulary; require bounded, nonblank string keys.
const isPermissionSet = (value: unknown): value is Set<string> =>
  value instanceof Set && [...value].every((key) =>
    typeof key === 'string' && key.length > 0 && key.length <= 256 && key.trim() === key,
  );

export function assertTenantAuthorizationContext(context: {
  userId?: unknown;
  businessId?: unknown;
  branchId?: unknown;
  businessWideAccess?: unknown;
  permissions?: unknown;
}): void {
  if (
    !isSafeIdentity(context.userId) ||
    !isSafeIdentity(context.businessId) ||
    typeof context.businessWideAccess !== 'boolean' ||
    !isPermissionSet(context.permissions) ||
    (context.branchId !== undefined && !isSafeIdentity(context.branchId)) ||
    (context.businessWideAccess === false &&
      !isSafeIdentity(context.branchId))
  ) {
    throw new AppError(
      'Tenant authorization context is unavailable.',
      403,
      'TENANT_CONTEXT_UNAVAILABLE',
    );
  }
}
