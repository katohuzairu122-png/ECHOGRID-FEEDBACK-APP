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
