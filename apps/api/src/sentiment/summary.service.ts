import type { Repositories } from '../repositories';
import type { FeedbackSummary } from '../repositories/feedback-summary.repository';
import { createSummaryGenerator, type SummaryGenerator } from './summary-generator';
import { formatPeriodLabel } from './period';
import { AppError } from '../lib/errors';

export interface GenerateSummaryOptions {
  businessId: string;
  branchId?: string | undefined;
  periodType: 'weekly' | 'monthly';
  periodStart: Date;
  periodEnd: Date;
}

// Caps how many raw comments get sent to the LLM per generation, regardless
// of how much feedback a period contains -- a deliberate cost/latency
// guardrail on an external paid API call, not a product-facing limit (see
// "never hard-code limits," which is about business-configurable behavior
// like point rates, not this kind of infrastructure safety valve).
const MAX_COMMENTS_IN_PROMPT = 100;

/**
 * Orchestrates one period's summary: pulls classified feedback
 * (SentimentService must have already run on it -- this reads
 * `feedback.sentiment`, it doesn't compute it), aggregates counts, calls the
 * LLM, and persists the result as a new `feedback_summaries` row.
 */
export class SummaryService {
  constructor(
    private readonly repos: Pick<Repositories, 'feedback' | 'feedbackSummaries' | 'businesses' | 'branches'>,
    private readonly generator: SummaryGenerator,
  ) {}

  async generateForPeriod(options: GenerateSummaryOptions): Promise<FeedbackSummary> {
    const { businessId, branchId, periodType, periodStart, periodEnd } = options;

    const business = await this.repos.businesses.findById(businessId);
    if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');

    const branch = branchId ? await this.repos.branches.findById(branchId, businessId) : undefined;
    if (branchId && !branch) throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');

    const items = await this.repos.feedback.listForPeriod(businessId, {
      branchId,
      from: periodStart,
      to: periodEnd,
    });

    const positiveCount = items.filter((i) => i.sentiment === 'positive').length;
    const neutralCount = items.filter((i) => i.sentiment === 'neutral').length;
    const negativeCount = items.filter((i) => i.sentiment === 'negative').length;

    const comments = items
      .map((i) => i.comment?.trim())
      .filter((c): c is string => Boolean(c))
      .slice(0, MAX_COMMENTS_IN_PROMPT);

    const result = await this.generator.generate({
      businessName: business.name,
      branchName: branch?.name,
      periodLabel: formatPeriodLabel(periodStart, periodEnd),
      feedbackCount: items.length,
      positiveCount,
      neutralCount,
      negativeCount,
      comments,
    });

    return this.repos.feedbackSummaries.create({
      businessId,
      branchId: branchId ?? null,
      periodType,
      periodStart,
      periodEnd,
      feedbackCount: items.length,
      positiveCount,
      neutralCount,
      negativeCount,
      summary: result.summary,
      recommendations: result.recommendations,
    });
  }
}

/** Convenience factory mirroring createSentimentService -- builds the
 * environment-appropriate generator (real Anthropic vs. dev console) so
 * callers (queue consumer, analytics.routes.ts) don't wire that up themselves. */
export function createSummaryService(
  repos: Pick<Repositories, 'feedback' | 'feedbackSummaries' | 'businesses' | 'branches'>,
  environment: 'development' | 'staging' | 'production',
  apiKey: string,
  model: string,
): SummaryService {
  return new SummaryService(repos, createSummaryGenerator(environment, apiKey, model));
}
