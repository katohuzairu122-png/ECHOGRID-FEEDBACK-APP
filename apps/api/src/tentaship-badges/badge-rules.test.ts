import { describe, expect, it } from 'vitest';
import { BLOCKED_BADGE_METRICS, BadgeRuleError, IMPLEMENTED_BADGE_METRICS, canonicalRuleJson, hashRule, parseBadgeRule } from './badge-rules';
import { isTentashipBadgesEnabled } from './badge-flag';

describe('TENTASHIP_BADGES_ENABLED (fail-closed, exact string only)', () => {
  it.each([[undefined, false], ['true', true], ['false', false], ['TRUE', false], ['True', false], ['1', false], ['yes', false], [' true', false], ['true ', false], ['', false], ['null', false], ['enabled', false]])(
    '%j -> %s', (value, expected) => {
      expect(isTentashipBadgesEnabled({ TENTASHIP_BADGES_ENABLED: value as string | undefined })).toBe(expected);
    },
  );
  it('is independent of every Community and future Shuffle/Drops control', () => {
    const env = { NETWORK_FEED_ENABLED: 'true', NETWORK_BUSINESS_PUBLISHING_ENABLED: 'true', NETWORK_BUSINESS_DISTRIBUTION_ENABLED: 'true', TENTASHIP_SHUFFLE_ENABLED: 'true', TENTASHIP_DROPS_ENABLED: 'true' };
    expect(isTentashipBadgesEnabled(env as never)).toBe(false);
    expect(isTentashipBadgesEnabled({ ...env, TENTASHIP_BADGES_ENABLED: 'true' } as never)).toBe(true);
    expect(isTentashipBadgesEnabled({ TENTASHIP_BADGES_ENABLED: 'true' })).toBe(true); // and needs none of them
  });
});

describe('badge rule: closed declarative schema', () => {
  it('accepts an implemented metric for its participant type, with optional window', () => {
    expect(parseBadgeRule({ metric: 'community_survey_completions', threshold: 3 }, 'customer')).toEqual({ metric: 'community_survey_completions', threshold: 3 });
    expect(parseBadgeRule({ metric: 'published_business_posts', threshold: 5, windowDays: 90 }, 'business')).toEqual({ metric: 'published_business_posts', threshold: 5, windowDays: 90 });
  });

  it.each([
    [{}, 'missing fields'], [{ metric: 'community_survey_completions' }, 'no threshold'], [{ metric: 'community_survey_completions', threshold: 0 }, 'zero'],
    [{ metric: 'community_survey_completions', threshold: 1.5 }, 'fraction'], [{ metric: 'community_survey_completions', threshold: 100001 }, 'too large'],
    [{ metric: 'community_survey_completions', threshold: 1, extra: 1 }, 'extra key'], [{ metric: 'community_survey_completions', threshold: 1, windowDays: 0 }, 'bad window'],
    [{ metric: 'x'.repeat(65), threshold: 1 }, 'long metric'], ['community_survey_completions', 'string'], [null, 'null'], [[], 'array'],
    [{ metric: 'a + b', threshold: 1 }, 'expression'], [{ metric: 'community_survey_completions', threshold: '3' }, 'string number'],
    [{ metric: '__proto__', threshold: 1 }, 'prototype key'], [{ metric: 'constructor', threshold: 1 }, 'inherited key'],
  ])('refuses %j (%s)', (rule) => {
    expect(() => parseBadgeRule(rule, 'customer')).toThrow(BadgeRuleError);
  });

  it('refuses every metric whose evidence definition is not Owner-approved, with the reason', () => {
    for (const metric of Object.keys(BLOCKED_BADGE_METRICS)) {
      try { parseBadgeRule({ metric, threshold: 1 }, 'customer'); throw new Error('should have thrown'); }
      catch (e) { expect((e as BadgeRuleError).code).toBe('BADGE_METRIC_BLOCKED'); expect((e as Error).message.length).toBeGreaterThan(10); }
    }
  });

  it('refuses a metric for the wrong participant type', () => {
    expect(() => parseBadgeRule({ metric: 'published_business_posts', threshold: 1 }, 'customer')).toThrow(/participant/);
    expect(() => parseBadgeRule({ metric: 'community_survey_completions', threshold: 1 }, 'business')).toThrow(/participant/);
  });

  it('implemented and blocked registries never overlap', () => {
    for (const m of Object.keys(IMPLEMENTED_BADGE_METRICS)) expect(Object.hasOwn(BLOCKED_BADGE_METRICS, m)).toBe(false);
  });

  it('hashes canonically: key order does not matter, any value change does', () => {
    const a = parseBadgeRule({ threshold: 3, metric: 'community_survey_completions' }, 'customer');
    const b = parseBadgeRule({ metric: 'community_survey_completions', threshold: 3 }, 'customer');
    expect(canonicalRuleJson(a)).toBe(canonicalRuleJson(b));
    expect(hashRule(a)).toBe(hashRule(b));
    expect(hashRule(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRule({ ...a, threshold: 4 })).not.toBe(hashRule(a));
  });
});
