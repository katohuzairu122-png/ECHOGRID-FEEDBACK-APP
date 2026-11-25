import 'server-only';
import type { BusinessCommunityStatus } from '@echo-grid-feedback/shared-types';
import { apiFetch } from './api-client';

/**
 * BCOMM-01: the Community rollout state shown to a business. Read from the API's read-only status route (which reports the real runtime
 * controls); never inferred or assumed here. Any failure, refusal or unexpected shape is `unavailable`, which the UI renders as "status
 * unavailable" and NEVER as open: an unread state must not look like an available capability.
 */
export type CommunityRollout = { state: 'ready'; status: BusinessCommunityStatus } | { state: 'unavailable' };

const isState = (value: unknown): value is 'open' | 'closed' => value === 'open' || value === 'closed';

export function parseCommunityStatus(value: unknown): CommunityRollout {
  if (!value || typeof value !== 'object') return { state: 'unavailable' };
  const v = value as Record<string, unknown>;
  // Publishing is not implemented, so anything other than 'closed' is rejected rather than trusted.
  if (!isState(v.enrollment) || !isState(v.feed) || v.publishing !== 'closed') return { state: 'unavailable' };
  return { state: 'ready', status: { enrollment: v.enrollment, feed: v.feed, publishing: 'closed' } };
}

export async function getBusinessCommunityStatus(businessId: string): Promise<CommunityRollout> {
  try {
    return parseCommunityStatus(await apiFetch<unknown>('/community/business/status', { businessId }));
  } catch {
    return { state: 'unavailable' };
  }
}
