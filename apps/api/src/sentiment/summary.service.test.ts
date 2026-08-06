import { describe, it, expect, vi } from 'vitest';
import { SummaryService } from './summary.service';
import type { SummaryGenerator, SummaryGenerationInput } from './summary-generator';
import type { Feedback, FeedbackRepository } from '../repositories/feedback.repository';
import type {
  FeedbackSummary,
  FeedbackSummaryRepository,
  NewFeedbackSummary,
} from '../repositories/feedback-summary.repository';
import type { Business, BusinessRepository } from '../repositories/business.repository';
import type { Branch, BranchRepository } from '../repositories/branch.repository';

const BUSINESS_A = 'business-a';
const BRANCH_A = 'branch-a';

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

/** SummaryGenerator is a plain interface, not a concrete class -- no cast
 * needed, a fake can implement it directly. */
function fakeGenerator(): SummaryGenerator {
  return {
    generate: vi.fn().mockResolvedValue({ summary: 'Fake summary.', recommendations: 'Fake rec.' }),
  };
}

function createFakeRepos(options: { items: Feedback[]; business: Business; branch?: Branch | undefined }) {
  const created: unknown[] = [];
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
    created,
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
    const service = new SummaryService(repos, generator);

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
    const service = new SummaryService(repos, generator);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.comments).toEqual(['Great stuff']);
  });

  it('caps the number of comments sent to the generator at 100, regardless of how much feedback the period has', async () => {
    const items = Array.from({ length: 150 }, (_, i) => makeFeedback({ comment: `Comment ${i}` }));
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.comments).toHaveLength(100);
    // feedbackCount still reflects the true total, not the capped prompt size.
    expect(call.feedbackCount).toBe(150);
  });

  it('persists the generator result as a new feedback_summaries row', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator);

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
    const service = new SummaryService(repos, fakeGenerator());

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND', status: 404 });
  });

  it('throws BRANCH_NOT_FOUND when a branchId is given but does not resolve', async () => {
    const repos = createFakeRepos({ items: [], business: BUSINESS, branch: undefined });
    const service = new SummaryService(repos, fakeGenerator());

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
    const service = new SummaryService(repos, fakeGenerator());

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    expect(repos.feedbackSummaries.create).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: null }),
    );
  });
});
