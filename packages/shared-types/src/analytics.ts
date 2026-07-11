import { z } from 'zod';

/**
 * AI Sentiment Analytics module contract (Block 4) -- trend charts,
 * searchable feedback, and AI-generated period summaries. Read-only from the
 * frontend's perspective except `generateSummarySchema`, the one action that
 * costs real Anthropic API money, so it's intentionally the narrowest
 * request shape here (a canned weekly/monthly period, not an arbitrary date
 * range -- see analytics.routes.ts for why).
 */

export const sentimentTrendPointSchema = z.object({
  bucket: z.string(), // ISO date (YYYY-MM-DD), one point per day
  positive: z.number().int().min(0),
  neutral: z.number().int().min(0),
  negative: z.number().int().min(0),
});
export type SentimentTrendPointDto = z.infer<typeof sentimentTrendPointSchema>;

export const feedbackSummaryDtoSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid().nullable(),
  periodType: z.enum(['weekly', 'monthly']),
  periodStart: z.string(),
  periodEnd: z.string(),
  feedbackCount: z.number().int().min(0),
  positiveCount: z.number().int().min(0),
  neutralCount: z.number().int().min(0),
  negativeCount: z.number().int().min(0),
  summary: z.string(),
  recommendations: z.string(),
  createdAt: z.string(),
});
export type FeedbackSummaryDto = z.infer<typeof feedbackSummaryDtoSchema>;

/**
 * On-demand generation request -- deliberately just `periodType` (+ optional
 * branchId), reusing the exact same computePeriodRange() logic the
 * automatic weekly/monthly cron uses, rather than accepting an arbitrary
 * date range. An open date-range parameter here would let a single request
 * trigger an unbounded-size, unbounded-cost Anthropic call; the trend/search
 * endpoints below are the free-range query surface, this is not.
 */
export const generateSummarySchema = z.object({
  branchId: z.uuid().optional(),
  periodType: z.enum(['weekly', 'monthly']),
});
export type GenerateSummaryInput = z.infer<typeof generateSummarySchema>;
