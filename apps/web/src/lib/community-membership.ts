import 'server-only';
import { customerApiFetch } from './customer-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';

export type CommunityPhoneEligibility = 'verified' | 'unverified' | 'unavailable';

/** Only the authoritative account status is used; no number or client assertion is exposed. */
export async function getCommunityPhoneEligibility(): Promise<CommunityPhoneEligibility> {
  try {
    const raw = await customerApiFetch<{ verified?: unknown }>('/loyalty/me/phone', { cache: 'no-store' }, '/loyalty/dashboard/community');
    if (typeof raw?.verified !== 'boolean') return 'unavailable';
    return raw.verified ? 'verified' : 'unverified';
  } catch (error) {
    rethrowControlFlow(error);
    return 'unavailable';
  }
}
