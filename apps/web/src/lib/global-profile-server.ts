import 'server-only';
import type { CustomerProfileDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

/**
 * The signed-in customer's global profile, or null when it cannot be read (for example while the profile service is not yet
 * available). Callers that only decorate a page (the "signed in as" display) must keep working on null. A 401 still redirects
 * to the sign-in page: control-flow errors are never swallowed.
 */
export async function loadGlobalProfile(): Promise<CustomerProfileDto | null> {
  try {
    return await customerApiFetch<CustomerProfileDto>('/customer-profile');
  } catch (error) {
    rethrowControlFlow(error);
    return null;
  }
}
