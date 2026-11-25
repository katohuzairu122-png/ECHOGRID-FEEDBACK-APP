import { describe, expect, it } from 'vitest';
import { gated, summarizeInsights, type RawInsights } from './community-insights-aggregate';

const base = (over: Partial<RawInsights> = {}): RawInsights => ({
  rangeDays: 30, from: '2026-01-01', to: '2026-01-30',
  impressions: { total: 500, distinct: 40 }, engagements: { total: 90, distinct: 25 }, newFollowers: { total: 12, distinct: 12 }, currentFollowers: 80,
  posts: [{ handle: 'AbCdEfGhIjKlMnOpQrStUv', excerpt: 'Fresh croissants', impressions: { total: 300, distinct: 30 }, engagements: { total: 8, distinct: 8 } }],
  ...over,
});

describe('gated', () => {
  it('shows a total only when enough DISTINCT customers are behind it (boundary 9/10), never below the total', () => {
    expect(gated({ total: 50, distinct: 9 }, 10)).toEqual({ state: 'suppressed' });
    expect(gated({ total: 50, distinct: 10 }, 10)).toEqual({ state: 'shown', value: 50 });
    expect(gated({ total: 3, distinct: 10 }, 10)).toEqual({ state: 'shown', value: 10 }); // a total can never be below its distinct people
    expect(gated({ total: -4, distinct: -1 }, 10)).toEqual({ state: 'suppressed' });
    expect(gated({ total: Number.NaN, distinct: Number.NaN }, 10)).toEqual({ state: 'suppressed' });
  });
});

describe('summarizeInsights', () => {
  it('shows every figure for a large audience and leaves attribution and profile visits explicitly unmeasured', () => {
    const r = summarizeInsights(base(), 10);
    expect(r).toMatchObject({
      impressions: { state: 'shown', value: 500 }, uniqueReach: { state: 'shown', value: 40 }, engagements: { state: 'shown', value: 90 },
      newFollowers: { state: 'shown', value: 12 }, currentFollowers: { state: 'shown', value: 80 },
      attribution: { state: 'not_measured' }, profileVisits: { state: 'not_measured' },
    });
    expect(r.posts[0]).toMatchObject({ impressions: { state: 'shown', value: 300 }, uniqueReach: { state: 'shown', value: 30 }, engagements: { state: 'suppressed' } });
  });
  it('hides every figure for a small audience, post figures included', () => {
    const r = summarizeInsights(base({ impressions: { total: 40, distinct: 6 }, engagements: { total: 9, distinct: 3 }, newFollowers: { total: 4, distinct: 4 }, currentFollowers: 9,
      posts: [{ handle: 'AbCdEfGhIjKlMnOpQrStUv', excerpt: 'x', impressions: { total: 20, distinct: 5 }, engagements: { total: 2, distinct: 2 } }] }), 10);
    for (const key of ['impressions', 'uniqueReach', 'engagements', 'newFollowers', 'currentFollowers'] as const) expect(r[key], key).toEqual({ state: 'suppressed' });
    expect(r.posts[0]).toMatchObject({ impressions: { state: 'suppressed' }, uniqueReach: { state: 'suppressed' }, engagements: { state: 'suppressed' } });
  });
  it('honours a larger configured group size and exposes only documented keys', () => {
    const r = summarizeInsights(base(), 50);
    expect(r.impressions).toEqual({ state: 'suppressed' });
    expect(r.currentFollowers).toEqual({ state: 'shown', value: 80 });
    expect(Object.keys(r).sort()).toEqual(['attribution', 'currentFollowers', 'engagements', 'from', 'impressions', 'minimumGroupSize', 'newFollowers', 'posts', 'profileVisits', 'rangeDays', 'to', 'uniqueReach']);
  });
});
