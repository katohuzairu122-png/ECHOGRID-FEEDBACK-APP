import 'server-only';
import type { BusinessCommunityParticipation, BusinessCommunityStatus, CommunityFigure } from '@echo-grid-feedback/shared-types';
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

/**
 * BCOMM-02: privacy-protected participation totals. The server decides what may be shown (small groups are suppressed there); this parser
 * accepts only the exact documented shape and treats anything else as `unavailable`. It never invents or estimates a number.
 */
export type CommunityParticipation = { state: 'ready'; data: BusinessCommunityParticipation } | { state: 'unavailable' };

function parseFigure(value: unknown): CommunityFigure | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.state === 'suppressed') return { state: 'suppressed' };
  if (v.state === 'shown' && typeof v.value === 'number' && Number.isInteger(v.value) && v.value >= 0) return { state: 'shown', value: v.value };
  return null;
}

export function parseCommunityParticipation(value: unknown): CommunityParticipation {
  if (!value || typeof value !== 'object') return { state: 'unavailable' };
  const v = value as Record<string, unknown>;
  const eligible = parseFigure(v.eligible);
  const participants = parseFigure(v.participants);
  const ratePercent = parseFigure(v.ratePercent);
  const size = v.minimumGroupSize;
  if (!eligible || !participants || !ratePercent || typeof size !== 'number' || !Number.isInteger(size) || size < 10) return { state: 'unavailable' };
  if (ratePercent.state === 'shown' && ratePercent.value > 100) return { state: 'unavailable' };
  return { state: 'ready', data: { minimumGroupSize: size, eligible, participants, ratePercent } };
}

export async function getBusinessCommunityParticipation(businessId: string): Promise<CommunityParticipation> {
  try {
    return parseCommunityParticipation(await apiFetch<unknown>('/community/business/participation', { businessId }));
  } catch {
    return { state: 'unavailable' };
  }
}
