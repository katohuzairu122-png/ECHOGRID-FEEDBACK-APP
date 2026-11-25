import 'server-only';
import { ApiError, apiFetch } from './api-client';
import { customerApiFetch } from './customer-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';
import { parseBadges, type BadgesResult } from './tentaship-badges-types';

/**
 * TB-03: the customer's badges. The API answers a generic 404 while TENTASHIP_BADGES_ENABLED is off; that is `closed` and the UI renders
 * NOTHING (no teaser, no empty state), so a disabled control is invisible to customers. Any other failure is `unavailable`, never "no badges".
 */
export async function getMyBadges(): Promise<BadgesResult> {
  try {
    return parseBadges(await customerApiFetch<unknown>('/tentaship-badges/me', { cache: 'no-store' }));
  } catch (error) {
    rethrowControlFlow(error);
    return error instanceof ApiError && error.status === 404 ? { state: 'closed' } : { state: 'unavailable' };
  }
}

export async function getBusinessBadges(businessId: string): Promise<BadgesResult> {
  try {
    return parseBadges(await apiFetch<unknown>('/tentaship-badges/business', { businessId, cache: 'no-store' }));
  } catch (error) {
    rethrowControlFlow(error);
    return error instanceof ApiError && error.status === 404 ? { state: 'closed' } : { state: 'unavailable' };
  }
}
