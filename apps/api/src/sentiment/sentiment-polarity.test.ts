import { describe, it, expect } from 'vitest';
import {
  SENTIMENT_VALUES,
  SENTIMENT_VALUES_BY_POLARITY,
  addSentimentToPolarityCounts,
  countSentimentPolarities,
  emptySentimentPolarityCounts,
  sentimentPolarity,
} from '@echo-grid-feedback/shared-types';

/**
 * Lives in apps/api rather than packages/shared-types because shared-types
 * has no test runner of its own, and adding vitest there is a dependency +
 * lockfile change that deserves its own decision. apps/api is the only
 * consumer of these helpers today.
 *
 * WHAT THESE GUARD (audit P2-1)
 * The 5-value sentiment scale gets rolled into 3 buckets in three places.
 * Each used to do it by hand, and the third one -- summary.service.ts --
 * matched only the original 3 literals, so 'very_positive' and
 * 'very_negative' rows were counted as nothing. The defect was invisible:
 * no exception, no empty result, just numbers that were quietly too low, in
 * a stored summary AND in the prompt the LLM then wrote prose from.
 *
 * So the assertion that matters most here is the boring one -- that the
 * strong values land in a bucket at all.
 */
describe('sentimentPolarity', () => {
  it('folds both ends of the 5-value scale into the 3 buckets', () => {
    expect(sentimentPolarity('very_positive')).toBe('positive');
    expect(sentimentPolarity('positive')).toBe('positive');
    expect(sentimentPolarity('neutral')).toBe('neutral');
    expect(sentimentPolarity('negative')).toBe('negative');
    expect(sentimentPolarity('very_negative')).toBe('negative');
  });

  it("maps 'unknown' to no bucket rather than to neutral", () => {
    // 'unknown' is the classifier saying it could not tell, which is not the
    // same statement as a customer being neutral. Bucketing it as neutral
    // would inflate that bucket with rows nobody formed an opinion about.
    expect(sentimentPolarity('unknown')).toBeNull();
  });

  it('maps unclassified rows to no bucket', () => {
    // sentiment is null until the async Level 2 pipeline reaches the row.
    expect(sentimentPolarity(null)).toBeNull();
    expect(sentimentPolarity(undefined)).toBeNull();
  });

  it('returns null for values that are not on the scale', () => {
    expect(sentimentPolarity('')).toBeNull();
    expect(sentimentPolarity('POSITIVE')).toBeNull();
    expect(sentimentPolarity('mildly_irked')).toBeNull();
  });

  it('is not fooled by inherited object properties', () => {
    // The lookup key comes from a varchar column, so it is untrusted at the
    // type level. On a plain object map, `map['constructor']` returns a
    // function and `?? null` does not catch it -- the reason the
    // implementation uses a Map.
    expect(sentimentPolarity('constructor')).toBeNull();
    expect(sentimentPolarity('__proto__')).toBeNull();
    expect(sentimentPolarity('toString')).toBeNull();
  });

  it('has a defined answer for every value on the scale', () => {
    // Catches a sixth sentiment value being added upstream without anyone
    // deciding which bucket it belongs in.
    for (const value of SENTIMENT_VALUES) {
      const polarity = sentimentPolarity(value);
      expect(polarity === null || ['positive', 'neutral', 'negative'].includes(polarity)).toBe(true);
    }
  });
});

describe('countSentimentPolarities', () => {
  const items = (...sentiments: (string | null)[]) => sentiments.map((sentiment) => ({ sentiment }));

  it('counts the strong values, which the pre-fix code dropped entirely', () => {
    // This is the exact regression. Against the old
    // `filter((i) => i.sentiment === 'positive')` implementation this
    // returns { positive: 0, neutral: 0, negative: 0 }.
    expect(countSentimentPolarities(items('very_positive', 'very_negative', 'very_positive'))).toEqual({
      positive: 2,
      neutral: 0,
      negative: 1,
    });
  });

  it('counts strong and plain values into the same bucket', () => {
    expect(
      countSentimentPolarities(items('very_positive', 'positive', 'neutral', 'negative', 'very_negative')),
    ).toEqual({ positive: 2, neutral: 1, negative: 2 });
  });

  it('leaves unclassified and unknown rows out of every bucket', () => {
    // Deliberate: the buckets are NOT required to sum to the row count.
    // Callers that need the total use items.length -- summary.service.ts
    // reports it separately as feedbackCount.
    const rows = items('positive', null, 'unknown', null);
    const counts = countSentimentPolarities(rows);

    expect(counts).toEqual({ positive: 1, neutral: 0, negative: 0 });
    expect(counts.positive + counts.neutral + counts.negative).toBeLessThan(rows.length);
  });

  it('returns all zeros for an empty period', () => {
    expect(countSentimentPolarities([])).toEqual({ positive: 0, neutral: 0, negative: 0 });
  });
});

describe('addSentimentToPolarityCounts', () => {
  it('adds a weight for pre-aggregated rows', () => {
    // sentimentTrend reads GROUP BY-ed rows where one row carries a count
    // of N, so it cannot use the per-item counter.
    const counts = emptySentimentPolarityCounts();
    addSentimentToPolarityCounts(counts, 'very_positive', 7);
    addSentimentToPolarityCounts(counts, 'positive', 3);
    addSentimentToPolarityCounts(counts, 'very_negative', 4);

    expect(counts).toEqual({ positive: 10, neutral: 0, negative: 4 });
  });

  it('ignores a weighted row with no bucket instead of losing the total silently', () => {
    const counts = emptySentimentPolarityCounts();
    addSentimentToPolarityCounts(counts, 'unknown', 99);
    expect(counts).toEqual({ positive: 0, neutral: 0, negative: 0 });
  });

  it('tolerates extra properties on the accumulator', () => {
    // sentimentTrend passes its bucket entry directly, which also carries
    // `bucket`. Asserted so that stays a supported call shape.
    const entry = { bucket: '2026-09-01', positive: 0, neutral: 0, negative: 0 };
    addSentimentToPolarityCounts(entry, 'very_negative', 2);
    expect(entry).toEqual({ bucket: '2026-09-01', positive: 0, neutral: 0, negative: 2 });
  });
});

describe('SENTIMENT_VALUES_BY_POLARITY', () => {
  it('expands a bucket name to every stored value that rolls into it', () => {
    expect([...SENTIMENT_VALUES_BY_POLARITY.positive].sort()).toEqual(['positive', 'very_positive']);
    expect([...SENTIMENT_VALUES_BY_POLARITY.negative].sort()).toEqual(['negative', 'very_negative']);
    expect([...SENTIMENT_VALUES_BY_POLARITY.neutral]).toEqual(['neutral']);
  });

  it('agrees with sentimentPolarity in both directions', () => {
    // The filter and the counter must never disagree about what "positive"
    // means, or the analytics dashboard shows a row count that its own
    // sentiment chart contradicts. Derived from one table, asserted as one
    // round trip.
    for (const [polarity, values] of Object.entries(SENTIMENT_VALUES_BY_POLARITY)) {
      for (const value of values) {
        expect(sentimentPolarity(value)).toBe(polarity);
      }
    }
    for (const value of SENTIMENT_VALUES) {
      const polarity = sentimentPolarity(value);
      if (polarity !== null) {
        expect(SENTIMENT_VALUES_BY_POLARITY[polarity]).toContain(value);
      }
    }
  });
});
