import { z } from 'zod';

/**
 * Automated Feedback Sorting taxonomy -- the single source of truth for
 * category/urgency/sentiment values, imported by both apps/api (Level 1/2
 * processing, inbox filtering) and apps/web (inbox UI labels/filters).
 *
 * `FEEDBACK_CATEGORIES` is deliberately NOT backed by a database CHECK
 * constraint (see apps/api/src/db/schema/feedback.ts's `category` column
 * comment) -- adding a new category is a one-line change to this array, not
 * a migration. `sentimentSchema`'s and `urgencySchema`'s value sets ARE
 * DB-CHECK-constrained (both are closed, fully-designed scales), so changing
 * either here without a matching migration would drift the contract from
 * what the database actually accepts.
 */
export const FEEDBACK_CATEGORIES = [
  'product_quality',
  'service_quality',
  'staff_conduct',
  'cleanliness',
  'waiting_time',
  'pricing',
  'payment',
  'delivery',
  'safety',
  'accessibility',
  'facilities',
  'loyalty_or_reward',
  'complaint',
  'compliment',
  'suggestion',
  'other',
] as const;

export const feedbackCategorySchema = z.enum(FEEDBACK_CATEGORIES);
export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>;

export const URGENCY_LEVELS = ['P0_CRITICAL', 'P1_HIGH', 'P2_NORMAL', 'P3_LOW'] as const;
export const urgencySchema = z.enum(URGENCY_LEVELS);
export type Urgency = z.infer<typeof urgencySchema>;

export const SENTIMENT_VALUES = ['very_negative', 'negative', 'neutral', 'positive', 'very_positive', 'unknown'] as const;
export const sentimentSchema = z.enum(SENTIMENT_VALUES);
export type Sentiment = z.infer<typeof sentimentSchema>;

/* -------------------------------------------------------------------------
 * Sentiment polarity -- the 3-bucket rollup of the 5-value scale.
 *
 * WHY THIS EXISTS (audit P2-1)
 * Automated Feedback Sorting widened `sentiment` from 3 values to 5, but
 * several already-shipped surfaces still present 3 (the analytics search
 * filter, the trend chart, the AI summary prompt). Each of those collapsed
 * 5 into 3 with its own hand-written string comparison, and they drifted:
 *
 *   - feedback.repository.ts `search`        -- expanded correctly
 *   - feedback.repository.ts `sentimentTrend` -- expanded correctly, but
 *     only after the same bug was found and fixed there
 *   - summary.service.ts                      -- NEVER expanded, so every
 *     'very_positive' / 'very_negative' row was counted as nothing at all,
 *     silently understating both ends of the scale in the stored summary
 *     and in the prompt sent to the LLM
 *
 * Three copies of one rule is why the third copy was wrong. This is the one
 * copy. It lives in shared-types (not apps/api) because this file is already
 * declared the single source of truth for the taxonomy, and because apps/web
 * renders the same three buckets.
 *
 * WHAT THIS IS NOT: a replacement for the 5-value scale. Storage, inbox
 * filtering and classification all keep full granularity -- only rollups
 * that are contractually 3-bucket use this.
 * ---------------------------------------------------------------------- */

export const SENTIMENT_POLARITIES = ['positive', 'neutral', 'negative'] as const;
export const sentimentPolaritySchema = z.enum(SENTIMENT_POLARITIES);
export type SentimentPolarity = z.infer<typeof sentimentPolaritySchema>;

/**
 * Exhaustive by type, which is the point: `Record<Sentiment, ...>` means
 * adding a sixth sentiment value above fails the build here until someone
 * decides which bucket it rolls into, instead of that value silently
 * vanishing from every rollup -- exactly the failure mode being fixed.
 *
 * 'unknown' maps to null deliberately. It is the classifier's "could not
 * determine" result, not a neutral opinion; counting it as neutral would
 * inflate the neutral bucket with rows that were never read.
 */
const POLARITY_OF: Readonly<Record<Sentiment, SentimentPolarity | null>> = {
  very_positive: 'positive',
  positive: 'positive',
  neutral: 'neutral',
  negative: 'negative',
  very_negative: 'negative',
  unknown: null,
};

/**
 * A Map rather than indexing POLARITY_OF directly. Callers pass values read
 * out of the database, typed `string | null` (the column is a CHECK-
 * constrained varchar, not a pg enum), so the lookup key is untrusted at the
 * type level. On a plain object literal, `obj['constructor']` returns a
 * function rather than undefined, and `?? null` would not catch it -- a Map
 * has no prototype chain to fall through to.
 */
const POLARITY_LOOKUP: ReadonlyMap<string, SentimentPolarity> = new Map(
  SENTIMENT_VALUES.flatMap((value) => {
    const polarity = POLARITY_OF[value];
    return polarity === null ? [] : [[value, polarity] as [string, SentimentPolarity]];
  }),
);

/** Returns null for 'unknown', for null/undefined, and for any value not in
 * SENTIMENT_VALUES -- i.e. "belongs in no bucket", never a default bucket. */
export function sentimentPolarity(sentiment: string | null | undefined): SentimentPolarity | null {
  if (sentiment === null || sentiment === undefined) return null;
  return POLARITY_LOOKUP.get(sentiment) ?? null;
}

/**
 * The inverse: every stored value that rolls into a given bucket. Used to
 * expand a 3-option UI filter into the `IN (...)` list a query needs, so the
 * filter and the counts can never disagree about what "positive" means.
 * Derived from POLARITY_OF rather than written out, so it cannot drift.
 */
export const SENTIMENT_VALUES_BY_POLARITY: Readonly<Record<SentimentPolarity, readonly Sentiment[]>> = {
  positive: SENTIMENT_VALUES.filter((value) => POLARITY_OF[value] === 'positive'),
  neutral: SENTIMENT_VALUES.filter((value) => POLARITY_OF[value] === 'neutral'),
  negative: SENTIMENT_VALUES.filter((value) => POLARITY_OF[value] === 'negative'),
};

export interface SentimentPolarityCounts {
  positive: number;
  neutral: number;
  negative: number;
}

export function emptySentimentPolarityCounts(): SentimentPolarityCounts {
  return { positive: 0, neutral: 0, negative: 0 };
}

/**
 * Adds one sentiment observation into `counts`, mutating and returning it.
 * `weight` exists for pre-aggregated callers -- sentimentTrend reads
 * `GROUP BY`ed rows where one row already carries a count of N.
 */
export function addSentimentToPolarityCounts(
  counts: SentimentPolarityCounts,
  sentiment: string | null | undefined,
  weight = 1,
): SentimentPolarityCounts {
  const polarity = sentimentPolarity(sentiment);
  if (polarity !== null) counts[polarity] += weight;
  return counts;
}

/**
 * Counts a list of feedback-shaped rows into the three buckets.
 *
 * The three counts deliberately do NOT sum to `items.length`: rows that are
 * unclassified (sentiment null, the async Level 2 pipeline has not reached
 * them yet) or 'unknown' belong to no bucket. Callers that need the total
 * must use items.length, which is what summary.service.ts already does for
 * feedbackCount.
 */
export function countSentimentPolarities(
  items: Iterable<{ sentiment: string | null }>,
): SentimentPolarityCounts {
  const counts = emptySentimentPolarityCounts();
  for (const item of items) addSentimentToPolarityCounts(counts, item.sentiment);
  return counts;
}
