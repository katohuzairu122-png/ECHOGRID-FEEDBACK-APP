import { describe, it, expect, vi } from 'vitest';
import { SummaryService } from './summary.service';
import { PROMPT_VERSION } from './summary-generator';
import type { SummaryGenerator, SummaryGenerationInput } from './summary-generator';
import type { Feedback, FeedbackRepository } from '../repositories/feedback.repository';
import type {
  FeedbackSummary,
  FeedbackSummaryRepository,
  NewFeedbackSummary,
} from '../repositories/feedback-summary.repository';
import type { AiUsageLog, AiUsageLogRepository, NewAiUsageLog } from '../repositories/ai-usage-log.repository';
import type { Business, BusinessRepository } from '../repositories/business.repository';
import type { Branch, BranchRepository } from '../repositories/branch.repository';

const BUSINESS_A = 'business-a';
const BRANCH_A = 'branch-a';
// Block 1 (S4.2 spend tracking) -- SummaryService's constructor grew two
// params (model, spendLimits). These are the "nothing interesting happening
// on the cost side" defaults every pre-existing test below now passes, so
// their own behavior (counting/comments/persistence) stays isolated from
// the new spend-limit logic covered in its own describe block further down.
const TEST_MODEL = 'claude-sonnet-5';
const PERMISSIVE_SPEND_LIMITS = { dailyLimitUsd: 1000, monthlyLimitUsd: 1000 };

function makeFeedback(overrides: Partial<Feedback> = {}): Feedback {
  return {
    id: crypto.randomUUID(),
    businessId: BUSINESS_A,
    branchId: BRANCH_A,
    qrCodeId: 'qr-1',
    rating: 5,
    comment: null,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    followUpQuestion: null,
    followUpAnswer: null,
    status: 'new',
    sentiment: null,
    sentimentScore: null,
    analysisStatus: 'completed',
    analyzedAt: new Date(),
    category: null,
    urgency: null,
    assignedTo: null,
    normalizedTextHash: null,
    isDuplicateText: false,
    createdAt: new Date(),
    createdBy: null,
    updatedAt: new Date(),
    updatedBy: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

const FAKE_USAGE = {
  model: TEST_MODEL,
  promptVersion: PROMPT_VERSION,
  inputTokens: 500,
  outputTokens: 150,
  costEstimateUsd: 0.0025,
};

/** SummaryGenerator is a plain interface, not a concrete class -- no cast
 * needed, a fake can implement it directly. */
function fakeGenerator(): SummaryGenerator {
  return {
    generate: vi
      .fn()
      .mockResolvedValue({ summary: 'Fake summary.', recommendations: 'Fake rec.', usage: FAKE_USAGE }),
  };
}

function createFakeRepos(options: {
  items: Feedback[];
  business: Business;
  branch?: Branch | undefined;
  /** Canned totals for the two totalCostSince calls enforceSpendLimit makes,
   * in the order it makes them (daily, then monthly) -- see
   * SummaryService.enforceSpendLimit's `Promise.all([daily, monthly])`.
   * Both default to 0 (no prior spend), so every pre-existing test below
   * that doesn't pass these is unaffected by the spend-limit check. */
  dailySpendUsd?: number;
  monthlySpendUsd?: number;
}) {
  const created: unknown[] = [];
  const usageLogRows: NewAiUsageLog[] = [];
  return {
    feedback: {
      listForPeriod: vi.fn().mockResolvedValue(options.items),
    } as unknown as FeedbackRepository,
    feedbackSummaries: {
      create: vi.fn().mockImplementation(async (input: NewFeedbackSummary) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), createdBy: null, ...input };
        created.push(row);
        return row as FeedbackSummary;
      }),
    } as unknown as FeedbackSummaryRepository,
    businesses: {
      findById: vi.fn().mockResolvedValue(options.business),
    } as unknown as BusinessRepository,
    branches: {
      findById: vi.fn().mockResolvedValue(options.branch),
    } as unknown as BranchRepository,
    aiUsageLog: {
      totalCostSince: vi
        .fn()
        .mockResolvedValueOnce(options.dailySpendUsd ?? 0)
        .mockResolvedValueOnce(options.monthlySpendUsd ?? 0),
      record: vi.fn().mockImplementation(async (input: NewAiUsageLog) => {
        usageLogRows.push(input);
        return { id: crypto.randomUUID(), createdAt: new Date(), ...input } as AiUsageLog;
      }),
    } as unknown as AiUsageLogRepository,
    created,
    usageLogRows,
  };
}

const BUSINESS: Business = {
  id: BUSINESS_A,
  name: 'Test Business',
  slug: 'test-business',
  createdAt: new Date(),
  createdBy: null,
  updatedAt: new Date(),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
} as Business;

describe('SummaryService.generateForPeriod', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('counts positive/neutral/negative feedback correctly and passes the counts to the generator', async () => {
    const items = [
      makeFeedback({ sentiment: 'positive' }),
      makeFeedback({ sentiment: 'positive' }),
      makeFeedback({ sentiment: 'neutral' }),
      makeFeedback({ sentiment: 'negative' }),
    ];
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.positiveCount).toBe(2);
    expect(call.neutralCount).toBe(1);
    expect(call.negativeCount).toBe(1);
    expect(call.feedbackCount).toBe(4);
  });

  it('only forwards non-empty, trimmed comments to the generator', async () => {
    const items = [
      makeFeedback({ comment: '  Great stuff  ' }),
      makeFeedback({ comment: null }),
      makeFeedback({ comment: '   ' }),
    ];
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.comments).toEqual(['Great stuff']);
  });

  it('caps the number of comments sent to the generator at 100, regardless of how much feedback the period has', async () => {
    const items = Array.from({ length: 150 }, (_, i) => makeFeedback({ comment: `Comment ${i}` }));
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.comments).toHaveLength(100);
    // feedbackCount still reflects the true total, not the capped prompt size.
    expect(call.feedbackCount).toBe(150);
  });

  it('persists the generator result as a new feedback_summaries row', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    const result = await service.generateForPeriod({
      businessId: BUSINESS_A,
      periodType: 'weekly',
      periodStart,
      periodEnd,
    });

    expect(result.summary).toBe('Fake summary.');
    expect(result.recommendations).toBe('Fake rec.');
    expect(repos.feedbackSummaries.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_A, periodType: 'weekly' }),
    );
  });

  it('throws BUSINESS_NOT_FOUND when the business does not exist', async () => {
    const repos = createFakeRepos({ items: [], business: undefined as unknown as Business });
    const service = new SummaryService(repos, fakeGenerator(), TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND', status: 404 });
  });

  it('throws BRANCH_NOT_FOUND when a branchId is given but does not resolve', async () => {
    const repos = createFakeRepos({ items: [], business: BUSINESS, branch: undefined });
    const service = new SummaryService(repos, fakeGenerator(), TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await expect(
      service.generateForPeriod({
        businessId: BUSINESS_A,
        branchId: BRANCH_A,
        periodType: 'weekly',
        periodStart,
        periodEnd,
      }),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', status: 404 });
  });

  it('stores branchId as null for a business-wide summary, not omitted -- NULL is the schema convention for "all branches"', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    const service = new SummaryService(repos, fakeGenerator(), TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    expect(repos.feedbackSummaries.create).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: null }),
    );
  });
});

describe('SummaryService.generateForPeriod -- spend-limit enforcement (S4.2)', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('blocks generation and never calls the generator (or reads feedback) once the daily spend limit is reached', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS, dailySpendUsd: 10 });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, { dailyLimitUsd: 10, monthlyLimitUsd: 1000 });

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toMatchObject({ code: 'AI_SPEND_LIMIT_EXCEEDED', status: 429 });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(repos.feedback.listForPeriod).not.toHaveBeenCalled();
  });

  it('blocks generation once the monthly spend limit is reached, even when the daily one is not', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS, dailySpendUsd: 0, monthlySpendUsd: 150 });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, { dailyLimitUsd: 10, monthlyLimitUsd: 150 });

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toMatchObject({ code: 'AI_SPEND_LIMIT_EXCEEDED', status: 429 });

    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('records a single "blocked" ai_usage_log row -- no tokens/cost -- when a limit is exceeded', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS, dailySpendUsd: 10 });
    const service = new SummaryService(repos, fakeGenerator(), TEST_MODEL, { dailyLimitUsd: 10, monthlyLimitUsd: 1000 });

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toThrow();

    expect(repos.usageLogRows).toEqual([
      expect.objectContaining({
        businessId: BUSINESS_A,
        branchId: null,
        callSite: 'summary_generation',
        model: TEST_MODEL,
        promptVersion: PROMPT_VERSION,
        status: 'blocked',
        inputTokens: null,
        outputTokens: null,
        costEstimateUsd: null,
      }),
    ]);
  });

  it('proceeds normally -- generator is called, no "blocked" row is written -- when spend is below both limits', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS, dailySpendUsd: 5, monthlySpendUsd: 50 });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, { dailyLimitUsd: 10, monthlyLimitUsd: 150 });

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(repos.usageLogRows.some((row) => row.status === 'blocked')).toBe(false);
  });
});

describe('SummaryService.generateForPeriod -- usage logging (S4.2)', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('records a "success" ai_usage_log row using the generator\'s own reported usage, not just the configured model', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    const service = new SummaryService(repos, fakeGenerator(), TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    expect(repos.usageLogRows).toEqual([
      expect.objectContaining({
        businessId: BUSINESS_A,
        branchId: null,
        callSite: 'summary_generation',
        status: 'success',
        model: FAKE_USAGE.model,
        promptVersion: FAKE_USAGE.promptVersion,
        inputTokens: FAKE_USAGE.inputTokens,
        outputTokens: FAKE_USAGE.outputTokens,
        costEstimateUsd: FAKE_USAGE.costEstimateUsd,
      }),
    ]);
  });

  it('records a "failed" ai_usage_log row using the configured model -- no result exists to read one from -- then rethrows', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    const failingGenerator: SummaryGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('Anthropic API request failed with status 500')),
    };
    const service = new SummaryService(repos, failingGenerator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toThrow('Anthropic API request failed with status 500');

    expect(repos.usageLogRows).toEqual([
      expect.objectContaining({
        businessId: BUSINESS_A,
        status: 'failed',
        model: TEST_MODEL,
        promptVersion: PROMPT_VERSION,
        inputTokens: null,
        outputTokens: null,
        costEstimateUsd: null,
      }),
    ]);
    // A failed generation must never still create a feedback_summaries row.
    expect(repos.feedbackSummaries.create).not.toHaveBeenCalled();
  });
});
