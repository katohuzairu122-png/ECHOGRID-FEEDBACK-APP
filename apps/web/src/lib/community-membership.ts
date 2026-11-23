import 'server-only';
import { communityTermsOfferSchema, type CommunityTermsOffer } from '@echo-grid-feedback/shared-types';
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

export async function getCommunityTermsOffer(locale: string): Promise<CommunityTermsOffer | null> {
  try {
    const raw = await customerApiFetch<{ offer: unknown }>('/community/me/terms?locale='+encodeURIComponent(locale), { cache: 'no-store' }, '/loyalty/dashboard/community');
    return raw.offer === null ? null : communityTermsOfferSchema.parse(raw.offer);
  } catch (error) { rethrowControlFlow(error); return null; }
}
