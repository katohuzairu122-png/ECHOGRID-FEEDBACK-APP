import 'server-only';
import type { BusinessCommunityInsights, CommunityFigure } from '@echo-grid-feedback/shared-types';
import { ApiError, apiFetch } from './api-client';

/**
 * BCOMM-05: verified engagement insights, read from the API. The server decides what may be shown (small audiences are suppressed there); this
 * parser accepts only the documented shape and treats anything else as unavailable. A 403 means the user may see the hub but not the figures.
 */
export const INSIGHT_RANGES = [7, 30, 90] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];
export type Insights = { state: 'ready'; data: BusinessCommunityInsights } | { state: 'forbidden' } | { state: 'unavailable' };

export function sanitizeRange(raw: string | string[] | undefined): InsightRange {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === '7' ? 7 : value === '90' ? 90 : 30;
}

function figure(value: unknown): CommunityFigure | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.state === 'suppressed') return { state: 'suppressed' };
  if (v.state === 'shown' && typeof v.value === 'number' && Number.isInteger(v.value) && v.value >= 0) return { state: 'shown', value: v.value };
  return null;
}

const HANDLE = /^[A-Za-z0-9_-]{22}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseInsights(value: unknown): Insights {
  if (!value || typeof value !== 'object') return { state: 'unavailable' };
  const v = value as Record<string, unknown>;
  const impressions = figure(v.impressions); const uniqueReach = figure(v.uniqueReach); const engagements = figure(v.engagements);
  const newFollowers = figure(v.newFollowers); const currentFollowers = figure(v.currentFollowers);
  const range = v.rangeDays;
  if (!impressions || !uniqueReach || !engagements || !newFollowers || !currentFollowers) return { state: 'unavailable' };
  if (range !== 7 && range !== 30 && range !== 90) return { state: 'unavailable' };
  if (typeof v.minimumGroupSize !== 'number' || !Number.isInteger(v.minimumGroupSize) || v.minimumGroupSize < 10) return { state: 'unavailable' };
  if (typeof v.from !== 'string' || !DAY.test(v.from) || typeof v.to !== 'string' || !DAY.test(v.to)) return { state: 'unavailable' };
  if ((v.attribution as { state?: unknown } | null)?.state !== 'not_measured' || (v.profileVisits as { state?: unknown } | null)?.state !== 'not_measured') return { state: 'unavailable' };
  if (!Array.isArray(v.posts) || v.posts.length > 10) return { state: 'unavailable' };
  const posts = [];
  for (const row of v.posts as Record<string, unknown>[]) {
    const pi = figure(row?.impressions); const pr = figure(row?.uniqueReach); const pe = figure(row?.engagements);
    if (!row || typeof row.handle !== 'string' || !HANDLE.test(row.handle) || typeof row.excerpt !== 'string' || !pi || !pr || !pe) return { state: 'unavailable' };
    posts.push({ handle: row.handle, excerpt: row.excerpt, impressions: pi, uniqueReach: pr, engagements: pe });
  }
  return {
    state: 'ready',
    data: {
      rangeDays: range, from: v.from, to: v.to, minimumGroupSize: v.minimumGroupSize, impressions, uniqueReach, engagements, newFollowers, currentFollowers,
      posts, attribution: { state: 'not_measured' }, profileVisits: { state: 'not_measured' },
    },
  };
}

export async function getBusinessInsights(businessId: string, days: InsightRange): Promise<Insights> {
  try {
    return parseInsights(await apiFetch<unknown>(`/community/business/insights?days=${days}`, { businessId }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return { state: 'forbidden' };
    return { state: 'unavailable' };
  }
}
