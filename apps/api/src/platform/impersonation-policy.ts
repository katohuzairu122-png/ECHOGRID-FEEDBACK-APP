import type { Bindings } from '../config/env';

/**
 * ACCESS-SEC-01A / owner ruling D1.
 *
 * An absent, malformed or non-exact value must never enable impersonation.
 * Changing the binding is a privileged release decision, NOT an API request
 * parameter or an authenticated user's preference.
 *
 * This predicate guards BOTH minting new tokens and authenticating tokens
 * already minted before the flag was disabled. It does not grant any role:
 * requirePlatformRole and the business-membership checks still apply.
 */
export function isPlatformImpersonationEnabled(
  env: Pick<Bindings, 'PLATFORM_IMPERSONATION_ENABLED'>,
): boolean {
  return env.PLATFORM_IMPERSONATION_ENABLED === 'true';
}
