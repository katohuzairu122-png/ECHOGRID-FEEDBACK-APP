import type { Repositories } from '../repositories';
import type { Feedback } from '../repositories/feedback.repository';
import type { SentimentTrendBucket } from '../repositories/feedback.repository';
import type { FeedbackSummary } from '../repositories/feedback-summary.repository';
import { AppError } from '../lib/errors';

const DEFAULT_RANGE_DAYS = 30;
// Guardrail against an accidentally (or maliciously) enormous range hitting
// the day-bucketed trend query / an unbounded search scan -- a genuine
// infra safety cap, not a product-facing "you can't view more than a year
// of history" limit a business would ever hit organically.
const MAX_RANGE_DAYS = 366;

export interface DateRangeInput {
  from?: string;
  to?: string;
}

function resolveRange({ from, to }: DateRangeInput): { from: Date; to: Date } {
  const resolvedTo = to ? new Date(to) : new Date();
  const resolvedFrom = from ? new Date(from) : new Date(resolvedTo.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);

  if (Number.isNaN(resolvedFrom.getTime()) || Number.isNaN(resolvedTo.getTime())) {
    throw new AppError('Invalid date range.', 400, 'INVALID_DATE_RANGE');
  }
  if (resolvedFrom > resolvedTo) {
    throw new AppError('`from` must be before `to`.', 400, 'INVALID_DATE_RANGE');
  }
  const rangeDays = (resolvedTo.getTime() - resolvedFrom.getTime()) / 86_400_000;
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new AppError(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`, 400, 'DATE_RANGE_TOO_LARGE');
  }

  return { from: resolvedFrom, to: resolvedTo };
}

/**
 * Read-side aggregation over feedback/feedback_summaries -- the
 * analytics:view surface. Deliberately holds no reference to `JOBS`/`AI`/
 * Anthropic bindings; those stay in analytics.routes.ts (the on-demand
 * generate endpoint) and the queue consumer, keeping this service pure
 * repository-composition like every other *.service.ts in the codebase.
 */
export class AnalyticsService {
  constructor(private readonly repos: Pick<Repositories, 'feedback' | 'feedbackSummaries'>) {}

  async trend(
    businessId: string,
    options: { branchId?: string } & DateRangeInput,
  ): Promise<SentimentTrendBucket[]> {
    const { from, to } = resolveRange(options);
    return this.repos.feedback.sentimentTrend(businessId, { branchId: options.branchId, from, to });
  }

  async search(
    businessId: string,
    options: {
      branchId?: string;
      sentiment?: 'positive' | 'neutral' | 'negative';
      rating?: number;
      keyword?: string;
      limit?: number;
      offset?: number;
    } & DateRangeInput,
  ): Promise<Feedback[]> {
    const { from, to } = resolveRange(options);
    return this.repos.feedback.search(businessId, { ...options, from, to });
  }

  async listSummaries(
    businessId: string,
    options: { branchId?: string; periodType?: 'weekly' | 'monthly'; limit?: number; offset?: number } = {},
  ): Promise<FeedbackSummary[]> {
    return this.repos.feedbackSummaries.listForBusiness(businessId, options);
  }
}
