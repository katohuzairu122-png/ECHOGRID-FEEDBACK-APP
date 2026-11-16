import 'server-only';
import { customerApiFetch } from './customer-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';

/**
 * Whether the Network Feed is enabled for this environment (GET /network/status). The Feed section of Community is
 * HIDDEN unless this answers `enabled: true` (NETWORK-00 section 0). Any failure, an unexpected shape or a disabled
 * flag hides the section: it is never shown on a guess, and Points & Membership never depends on this call.
 * A 401 redirects to the customer login (control flow, re-thrown).
 */
export async function getNetworkFeedEnabled(): Promise<boolean> {
  try {
    const status = await customerApiFetch<{ enabled?: unknown }>('/network/status', { cache: 'no-store' });
    return status?.enabled === true;
  } catch (error) {
    rethrowControlFlow(error);
    return false;
  }
}
