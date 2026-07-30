import { describe, it, expect, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';
import type {
  SentimentTrendBucket,
  Feedback,
  FeedbackRepository,
} from '../repositories/feedback.repository';
import type {
  FeedbackSummary,
  FeedbackSummaryRepository,
} from '../repositories/feedback-summary.repository';

const BUSINESS_A = 'business-a';

/**
 * Only the 3 methods AnalyticsService actually calls -- cast to the full
 * repository types (rather than widening AnalyticsService's constructor
 * parameter) since every other service in this codebase types its
 * constructor against the real Repositories shape, and a test-only fake
 * shouldn't be the reason to loosen that.
 */
function createFakeRepos() {
  const trendResult: SentimentTrendBucket[] = [];
  const searchResult: Feedback[] = [];
  const summariesResult: FeedbackSummary[] = [];

  return {
    feedback: {
      sentimentTrend: vi.fn().mockResolvedValue(trendResult),
      search: vi.fn().mockResolvedValue(searchResult),
    } as unknown as FeedbackRepository,
    feedbackSummaries: {
      listForBusiness: vi.fn().mockResolvedValue(summariesResult),
    } as unknown as FeedbackSummaryRepository,
  };
}

describe('AnalyticsService.trend', () => {
  it('defaults to a 30-day range ending now when no from/to is given', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);
    const before = Date.now();

    await service.trend(BUSINESS_A, {});

    const call = vi.mocked(repos.feedback.sentimentTrend).mock.calls[0]![1];
    const rangeDays = (call.to.getTime() - call.from.getTime()) / 86_400_000;
    expect(rangeDays).toBeCloseTo(30, 5);
    expect(call.to.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('passes branchId through when given', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await service.trend(BUSINESS_A, { branchId: 'branch-1' });

    expect(repos.feedback.sentimentTrend).toHaveBeenCalledWith(
      BUSINESS_A,
      expect.objectContaining({ branchId: 'branch-1' }),
    );
  });

  it('rejects an invalid date string', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await expect(service.trend(BUSINESS_A, { from: 'not-a-date' })).rejects.toMatchObject({
      code: 'INVALID_DATE_RANGE',
      status: 400,
    });
  });

  it('rejects `from` after `to`', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await expect(
      service.trend(BUSINESS_A, { from: '2026-07-09', to: '2026-07-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });
  });

  it('rejects a range longer than 366 days -- an infra guardrail, not a product-facing limit a business would organically hit', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await expect(
      service.trend(BUSINESS_A, { from: '2020-01-01', to: '2026-07-09' }),
    ).rejects.toMatchObject({ code: 'DATE_RANGE_TOO_LARGE' });
  });

  it('accepts an explicit range at exactly the 366-day boundary', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await expect(
      service.trend(BUSINESS_A, { from: '2025-07-08', to: '2026-07-09' }),
    ).resolves.toBeDefined();
  });
});

describe('AnalyticsService.search', () => {
  it('passes sentiment/rating/keyword filters through to the repository unchanged', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await service.search(BUSINESS_A, { sentiment: 'negative', rating: 2, keyword: 'slow' });

    expect(repos.feedback.search).toHaveBeenCalledWith(
      BUSINESS_A,
      expect.objectContaining({ sentiment: 'negative', rating: 2, keyword: 'slow' }),
    );
  });

  it('still validates the date range the same way trend does', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await expect(
      service.search(BUSINESS_A, { from: '2026-07-09', to: '2026-07-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });
  });
});

describe('AnalyticsService.listSummaries', () => {
  it('delegates directly to the repository with no date-range validation -- summaries are already period-scoped rows, not a free date query', async () => {
    const repos = createFakeRepos();
    const service = new AnalyticsService(repos);

    await service.listSummaries(BUSINESS_A, { periodType: 'weekly' });

    expect(repos.feedbackSummaries.listForBusiness).toHaveBeenCalledWith(BUSINESS_A, {
      periodType: 'weekly',
    });
  });
});
