import { AppError } from '../lib/errors';

/**
 * Fail closed when authorization guards are accidentally mounted without
 * authenticate + resolveTenantContext, or when a partial context is supplied.
 * The middleware chain supplies these values from trusted database-backed
 * checks; this helper does NOT replace membership or permission resolution.
 */
export function assertTenantAuthorizationContext(context: {
  userId?: unknown;
  businessId?: unknown;
  branchId?: unknown;
  businessWideAccess?: unknown;
  permissions?: unknown;
}): void {
  if (
    typeof context.userId !== 'string' || context.userId.length === 0 ||
    typeof context.businessId !== 'string' || context.businessId.length === 0 ||
    typeof context.businessWideAccess !== 'boolean' ||
    !(context.permissions instanceof Set) ||
    (context.businessWideAccess === false &&
      (typeof context.branchId !== 'string' || context.branchId.length === 0))
  ) {
    throw new AppError(
      'Tenant authorization context is unavailable.',
      403,
      'TENANT_CONTEXT_UNAVAILABLE',
    );
  }
}
