import {
  type BusinessCommunityInsightPost, type BusinessCommunityInsights, type CommunityFigure,
} from '@echo-grid-feedback/shared-types';

/**
 * BCOMM-05 small-group suppression for engagement metrics. Pure and deterministic; the single place the disclosure rule lives.
 * A total is disclosed only when the DISTINCT customers behind it number at least the group size. Totals are never shown beside a hidden
 * distinct count in a way that lets one be derived from the other (impressions need reach; engagements need engagers). The group size is the same
 * Owner-approved, configuration-only-upward value as the participation totals (BCOMM-02): this module never lowers it.
 */
export interface RawCount { total: number; distinct: number }
export interface RawInsights {
  rangeDays: 7 | 30 | 90; from: string; to: string;
  impressions: RawCount; engagements: RawCount; newFollowers: RawCount; currentFollowers: number;
  posts: { handle: string; excerpt: string; impressions: RawCount; engagements: RawCount }[];
}

const shown = (value: number): CommunityFigure => ({ state: 'shown', value });
const suppressed: CommunityFigure = { state: 'suppressed' };
const whole = (n: number) => Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0));

/** `total` is shown only when `distinct` (the people behind it) reaches the group size. */
export function gated(raw: RawCount, k: number): CommunityFigure {
  const distinct = whole(raw.distinct);
  const total = Math.max(whole(raw.total), distinct);
  return distinct >= k ? shown(total) : suppressed;
}

export function summarizeInsights(raw: RawInsights, k: number): BusinessCommunityInsights {
  const reach: CommunityFigure = whole(raw.impressions.distinct) >= k ? shown(whole(raw.impressions.distinct)) : suppressed;
  const posts: BusinessCommunityInsightPost[] = raw.posts.map((p) => ({
    handle: p.handle,
    excerpt: p.excerpt,
    impressions: gated(p.impressions, k),
    uniqueReach: whole(p.impressions.distinct) >= k ? shown(whole(p.impressions.distinct)) : suppressed,
    engagements: gated(p.engagements, k),
  }));
  return {
    rangeDays: raw.rangeDays, from: raw.from, to: raw.to, minimumGroupSize: k,
    impressions: gated(raw.impressions, k),
    uniqueReach: reach,
    engagements: gated(raw.engagements, k),
    newFollowers: gated({ total: raw.newFollowers.distinct, distinct: raw.newFollowers.distinct }, k),
    currentFollowers: whole(raw.currentFollowers) >= k ? shown(whole(raw.currentFollowers)) : suppressed,
    posts,
    attribution: { state: 'not_measured' },
    profileVisits: { state: 'not_measured' },
  };
}
