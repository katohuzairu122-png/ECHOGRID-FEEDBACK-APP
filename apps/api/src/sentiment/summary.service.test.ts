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
import type { CriticalIncident, CriticalIncidentRepository } from '../repositories/critical-incident.repository';
import type { FraudSignal, FraudSignalRepository } from '../repositories/fraud-signal.repository';
import type { LoyaltyTransaction, LoyaltyTransactionRepository } from '../repositories/loyalty-transaction.repository';

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

// S4 roadmap Block 5 -- three more makeX() builders, same "only the field(s)
// this test cares about are overridden" convention as makeFeedback() above.
function makeCriticalIncident(overrides: Partial<CriticalIncident> = {}): CriticalIncident {
  return {
    id: crypto.randomUUID(),
    businessId: BUSINESS_A,
    branchId: BRANCH_A,
    feedbackId: crypto.randomUUID(),
    matchedSignals: 'fire, emergency',
    acknowledgedAt: null,
    acknowledgedBy: null,
    escalatedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeFraudSignal(overrides: Partial<FraudSignal> = {}): FraudSignal {
  return {
    id: crypto.randomUUID(),
    businessId: BUSINESS_A,
    branchId: BRANCH_A,
    feedbackId: null,
    signalType: 'velocity',
    reasonCode: 'device_velocity_exceeded',
    severity: 'low',
    status: 'open',
    metadata: null,
    detectedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    ...overrides,
  };
}

function makeLoyaltyTransaction(overrides: Partial<LoyaltyTransaction> = {}): LoyaltyTransaction {
  return {
    id: crypto.randomUUID(),
    loyaltyAccountId: crypto.randomUUID(),
    type: 'checkin',
    points: 10,
    relatedRewardId: null,
    relatedQrCodeId: null,
    visitSessionId: null,
    feedbackId: null,
    purchaseAmount: null,
    redemptionCode: null,
    redemptionConfirmedAt: null,
    issuanceStatus: null,
    notes: null,
    createdAt: new Date(),
    createdBy: null,
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
  /** S4 roadmap Block 4 -- feedback for the immediately-preceding period,
   * returned by listForPeriod's 2nd call (see below). Defaults to []: every
   * pre-existing test below that doesn't pass this gets a real, empty
   * previous period rather than an error, and none of them assert on
   * previousPeriod/categoryBreakdown/urgencyBreakdown, so they're
   * unaffected. */
  previousItems?: Feedback[];
  /** S4 roadmap Block 5 -- critical incidents/fraud signals/loyalty
   * transactions for the current period. All three default to [], so every
   * pre-existing test below (and every Block 4 test, which doesn't pass
   * these either) gets real, empty cross-domain data rather than an error,
   * and none of them assert on criticalIncidents/fraudSignals/
   * loyaltyActivity, so they're unaffected. */
  criticalIncidentRows?: CriticalIncident[];
  fraudSignalRows?: FraudSignal[];
  loyaltyTransactionRows?: LoyaltyTransaction[];
  /** Canned totals for the two totalCostSince calls enforceSpendLimit makes,
   * in the order it makes them (daily, then monthly) -- see
   * SummaryService.enforceSpendLimit's `Promise.all([daily, monthly])`.
   * Both default to 0 (no prior spend), so every pre-existing test below
   * that doesn't pass these is unaffected by the spend-limit check. */
  dailySpendUsd?: number;
  monthlySpendUsd?: number;
}) {
  const created: unknown[] = [];
  // S4 roadmap Block 7 -- typed as AiUsageLog[] (real rows, with an id),
  // not NewAiUsageLog[] (raw insert input): resolve() below needs to find
  // and mutate an existing entry by id, mirroring the real repository's
  // record()-then-update-in-place behavior.
  const usageLogRows: AiUsageLog[] = [];
  return {
    feedback: {
      // 1st call: the current period (generateForPeriod's `items`). 2nd
      // call: the previous period (S4 roadmap Block 4's `previousItems`) --
      // same chained-mock pattern as totalCostSince below (daily, then
      // monthly). generateForPeriod calls listForPeriod exactly twice per
      // invocation, so every test below gets exactly these two queued
      // results regardless of whether it cares about the 2nd one.
      listForPeriod: vi
        .fn()
        .mockResolvedValueOnce(options.items)
        .mockResolvedValueOnce(options.previousItems ?? []),
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
    // S4 roadmap Block 5 -- one call per generateForPeriod invocation each
    // (unlike feedback.listForPeriod's two), so a plain mockResolvedValue
    // is enough; no Once-chaining needed.
    criticalIncidents: {
      listForPeriod: vi.fn().mockResolvedValue(options.criticalIncidentRows ?? []),
    } as unknown as CriticalIncidentRepository,
    fraudSignals: {
      listForPeriod: vi.fn().mockResolvedValue(options.fraudSignalRows ?? []),
    } as unknown as FraudSignalRepository,
    loyaltyTransactions: {
      listForBusinessPeriod: vi.fn().mockResolvedValue(options.loyaltyTransactionRows ?? []),
    } as unknown as LoyaltyTransactionRepository,
    aiUsageLog: {
      totalCostSince: vi
        .fn()
        .mockResolvedValueOnce(options.dailySpendUsd ?? 0)
        .mockResolvedValueOnce(options.monthlySpendUsd ?? 0),
      // S4 roadmap Block 7 -- record() and resolve() share this same
      // backing array. resolve() mutates an existing entry in place rather
      // than pushing a new one, mirroring a real UPDATE: one attempt is
      // always exactly one row, whether it's 'blocked' outright, still
      // 'pending', or has since been resolve()d to 'success'/'failed'.
      record: vi.fn().mockImplementation(async (input: NewAiUsageLog) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), resolvedAt: null, ...input } as AiUsageLog;
        usageLogRows.push(row);
        return row;
      }),
      resolve: vi.fn().mockImplementation(
        async (
          id: string,
          updates: {
            status: 'success' | 'failed';
            model: string;
            promptVersion: string;
            inputTokens: number | null;
            outputTokens: number | null;
            costEstimateUsd: number | null;
          },
        ) => {
          // Same `WHERE status = 'pending'` guard the real repository's
          // UPDATE applies -- resolving an already-resolved row is a no-op.
          const row = usageLogRows.find((r) => r.id === id && r.status === 'pending');
          if (!row) return undefined;
          Object.assign(row, updates, { resolvedAt: new Date() });
          return row;
        },
      ),
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

// S4 roadmap Block 4 -- needed so tests can pass a resolving branchId
// (generateForPeriod throws BRANCH_NOT_FOUND otherwise) to check that the
// previous-period fetch is scoped to the same branch as the current one.
const BRANCH: Branch = {
  id: BRANCH_A,
  businessId: BUSINESS_A,
  name: 'Test Branch',
  slug: 'test-branch',
  timezone: 'UTC',
  status: 'active',
  createdAt: new Date(),
  createdBy: null,
  updatedAt: new Date(),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
} as Branch;

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

describe('SummaryService.generateForPeriod -- pending/failed job status (S4 roadmap Block 7)', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('writes a "pending" row before calling the generator, then resolves that same row to "success" -- not a second row', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    // Captured synchronously the instant generate() is invoked, before it
    // resolves -- proves the pending row exists BEFORE the attempt
    // concludes, not just "eventually, somewhere in the final state" (which
    // the existing "usage logging" tests above don't actually distinguish
    // from this new pending-first behavior on their own).
    let pendingRowAtGenerateTime: unknown;
    const generator: SummaryGenerator = {
      generate: vi.fn().mockImplementation(async () => {
        pendingRowAtGenerateTime = { ...repos.usageLogRows[0] };
        return { summary: 'Fake summary.', recommendations: 'Fake rec.', usage: FAKE_USAGE };
      }),
    };
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    expect(pendingRowAtGenerateTime).toMatchObject({
      businessId: BUSINESS_A,
      branchId: null,
      callSite: 'summary_generation',
      status: 'pending',
      model: TEST_MODEL,
      promptVersion: PROMPT_VERSION,
      inputTokens: null,
      outputTokens: null,
      costEstimateUsd: null,
      resolvedAt: null,
    });
    // Exactly one row total, and it's the SAME row (same id) now resolved
    // to 'success' with real usage -- not a second row appended alongside
    // the pending one.
    expect(repos.usageLogRows).toHaveLength(1);
    expect(repos.usageLogRows[0]!.id).toBe((pendingRowAtGenerateTime as { id: string }).id);
    expect(repos.usageLogRows[0]).toMatchObject({
      status: 'success',
      model: FAKE_USAGE.model,
      promptVersion: FAKE_USAGE.promptVersion,
      inputTokens: FAKE_USAGE.inputTokens,
      outputTokens: FAKE_USAGE.outputTokens,
      costEstimateUsd: FAKE_USAGE.costEstimateUsd,
    });
    expect(repos.usageLogRows[0]!.resolvedAt).not.toBeNull();
  });

  it('resolves the same pending row to "failed" (not a second row) when the generator throws', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS });
    const failingGenerator: SummaryGenerator = {
      generate: vi.fn().mockRejectedValue(new Error('Anthropic API request failed with status 500')),
    };
    const service = new SummaryService(repos, failingGenerator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toThrow('Anthropic API request failed with status 500');

    expect(repos.usageLogRows).toHaveLength(1);
    expect(repos.usageLogRows[0]).toMatchObject({
      status: 'failed',
      model: TEST_MODEL,
      promptVersion: PROMPT_VERSION,
      inputTokens: null,
      outputTokens: null,
      costEstimateUsd: null,
    });
    expect(repos.usageLogRows[0]!.resolvedAt).not.toBeNull();
  });

  it('never writes a "pending" row at all when the spend limit blocks generation -- enforceSpendLimit runs first', async () => {
    const repos = createFakeRepos({ items: [makeFeedback()], business: BUSINESS, dailySpendUsd: 10 });
    const service = new SummaryService(repos, fakeGenerator(), TEST_MODEL, { dailyLimitUsd: 10, monthlyLimitUsd: 1000 });

    await expect(
      service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd }),
    ).rejects.toThrow();

    // Exactly the one 'blocked' row from enforceSpendLimit -- no separate
    // 'pending' row was ever written, since a blocked attempt never starts
    // the work 'pending' represents.
    expect(repos.usageLogRows).toHaveLength(1);
    expect(repos.usageLogRows[0]!.status).toBe('blocked');
  });
});

describe('SummaryService.generateForPeriod -- PII redaction (S4.1/S4.2, Block 2)', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('redacts a generic email/phone pattern before it reaches the generator', async () => {
    const items = [makeFeedback({ comment: 'reach me at jane@example.com or 555-123-4567' })];
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.comments).toEqual(['reach me at [email redacted] or [phone redacted]']);
  });

  it("redacts this row's own customerName/customerEmail/customerPhone when restated in its comment, using that row's fields (not another row's)", async () => {
    const items = [
      makeFeedback({ comment: 'Hi, John Smith here, loved it!', customerName: 'John Smith' }),
      makeFeedback({ comment: 'Jane Doe was not happy.', customerName: 'Jane Doe' }),
    ];
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.comments).toEqual(['Hi, [redacted] here, loved it!', '[redacted] was not happy.']);
  });
});

describe('SummaryService.generateForPeriod -- category/urgency breakdown + previous period (S4 roadmap Block 4)', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('computes category/urgency breakdowns from `items`, sorted by count descending, with an "unclassified" bucket for null', async () => {
    const items = [
      makeFeedback({ category: 'product_quality', urgency: 'P1_HIGH' }),
      makeFeedback({ category: 'product_quality', urgency: 'P1_HIGH' }),
      makeFeedback({ category: 'product_quality', urgency: 'P1_HIGH' }),
      makeFeedback({ category: 'staff_conduct', urgency: 'P1_HIGH' }),
      makeFeedback({ category: 'staff_conduct', urgency: null }),
      makeFeedback({ category: null, urgency: null }),
    ];
    const repos = createFakeRepos({ items, business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    // 6 items total -- every bucket's counts must sum back to items.length,
    // confirming no item was silently dropped instead of bucketed as
    // 'unclassified'.
    expect(call.categoryBreakdown).toEqual([
      { label: 'product_quality', count: 3 },
      { label: 'staff_conduct', count: 2 },
      { label: 'unclassified', count: 1 },
    ]);
    expect(call.urgencyBreakdown).toEqual([
      { label: 'P1_HIGH', count: 4 },
      { label: 'unclassified', count: 2 },
    ]);
  });

  it('fetches the previous period from the same business/branch scope, using the immediately-preceding window', async () => {
    const items = [makeFeedback()];
    const previousItems = [makeFeedback()];
    const repos = createFakeRepos({ items, business: BUSINESS, branch: BRANCH, previousItems });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      periodType: 'weekly',
      periodStart,
      periodEnd,
    });

    // Exactly 2 calls -- catches an accidental 3rd query as readily as a
    // missing 2nd one.
    expect(repos.feedback.listForPeriod).toHaveBeenCalledTimes(2);
    expect(repos.feedback.listForPeriod).toHaveBeenNthCalledWith(1, BUSINESS_A, {
      branchId: BRANCH_A,
      from: periodStart,
      to: periodEnd,
    });
    // computePreviousPeriodRange(periodStart, periodEnd) for this 7-day
    // window: periodEnd becomes periodStart (2026-07-01), and periodStart
    // moves back by the same 7-day duration (to 2026-06-24) -- see
    // period.test.ts's own 'weekly' case for the same arithmetic.
    expect(repos.feedback.listForPeriod).toHaveBeenNthCalledWith(2, BUSINESS_A, {
      branchId: BRANCH_A,
      from: new Date('2026-06-24T00:00:00.000Z'),
      to: new Date('2026-07-01T00:00:00.000Z'),
    });
  });

  it('passes real previous-period counts and label through to the generator, not a placeholder', async () => {
    const items = [makeFeedback({ sentiment: 'positive' })];
    const previousItems = [
      makeFeedback({ sentiment: 'positive' }),
      makeFeedback({ sentiment: 'positive' }),
      makeFeedback({ sentiment: 'neutral' }),
      makeFeedback({ sentiment: 'negative' }),
    ];
    const repos = createFakeRepos({ items, business: BUSINESS, previousItems });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.previousPeriod).toEqual({
      periodLabel: '2026-06-24 to 2026-07-01',
      feedbackCount: 4,
      positiveCount: 2,
      neutralCount: 1,
      negativeCount: 1,
    });
  });

  it('defaults to a real, empty previous period (all-zero counts) when the caller does not supply previousItems, and to empty breakdowns when the current period has no feedback', async () => {
    const repos = createFakeRepos({ items: [], business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.previousPeriod).toEqual({
      periodLabel: '2026-06-24 to 2026-07-01',
      feedbackCount: 0,
      positiveCount: 0,
      neutralCount: 0,
      negativeCount: 0,
    });
    expect(call.categoryBreakdown).toEqual([]);
    expect(call.urgencyBreakdown).toEqual([]);
  });
});

describe('SummaryService.generateForPeriod -- cross-domain aggregates (S4 roadmap Block 5)', () => {
  const periodStart = new Date('2026-07-01T00:00:00.000Z');
  const periodEnd = new Date('2026-07-08T00:00:00.000Z');

  it('computes critical incident count and unacknowledged count, passed through to the generator', async () => {
    const criticalIncidentRows = [
      makeCriticalIncident({ acknowledgedAt: null }),
      makeCriticalIncident({ acknowledgedAt: new Date() }),
      makeCriticalIncident({ acknowledgedAt: null }),
    ];
    const repos = createFakeRepos({ items: [], business: BUSINESS, criticalIncidentRows });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.criticalIncidents).toEqual({ count: 3, unacknowledgedCount: 2 });
  });

  it('computes fraud signal count and severity breakdown, passed through to the generator', async () => {
    const fraudSignalRows = [
      makeFraudSignal({ severity: 'high' }),
      makeFraudSignal({ severity: 'high' }),
      makeFraudSignal({ severity: 'low' }),
    ];
    const repos = createFakeRepos({ items: [], business: BUSINESS, fraudSignalRows });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.fraudSignals).toEqual({
      count: 3,
      severityBreakdown: [
        { label: 'high', count: 2 },
        { label: 'low', count: 1 },
      ],
    });
  });

  it('computes loyalty activity count and type breakdown, passed through to the generator', async () => {
    const loyaltyTransactionRows = [
      makeLoyaltyTransaction({ type: 'checkin' }),
      makeLoyaltyTransaction({ type: 'checkin' }),
      makeLoyaltyTransaction({ type: 'redemption' }),
    ];
    const repos = createFakeRepos({ items: [], business: BUSINESS, loyaltyTransactionRows });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.loyaltyActivity).toEqual({
      count: 3,
      typeBreakdown: [
        { label: 'checkin', count: 2 },
        { label: 'redemption', count: 1 },
      ],
    });
  });

  it('scopes critical incidents and fraud signals to the same branch as the current period, when a branchId is given', async () => {
    const repos = createFakeRepos({ items: [], business: BUSINESS, branch: BRANCH });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      periodType: 'weekly',
      periodStart,
      periodEnd,
    });

    expect(repos.criticalIncidents.listForPeriod).toHaveBeenCalledWith(BUSINESS_A, {
      branchId: BRANCH_A,
      from: periodStart,
      to: periodEnd,
    });
    expect(repos.fraudSignals.listForPeriod).toHaveBeenCalledWith(BUSINESS_A, {
      branchId: BRANCH_A,
      from: periodStart,
      to: periodEnd,
    });
  });

  it('fetches loyalty activity business-wide, with no branchId, even when the summary itself is branch-scoped', async () => {
    const repos = createFakeRepos({ items: [], business: BUSINESS, branch: BRANCH });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      periodType: 'weekly',
      periodStart,
      periodEnd,
    });

    // No branchId key at all -- loyalty_transactions has no branch
    // dimension to scope to (see
    // LoyaltyTransactionRepository.listForBusinessPeriod's own comment).
    expect(repos.loyaltyTransactions.listForBusinessPeriod).toHaveBeenCalledWith(BUSINESS_A, {
      from: periodStart,
      to: periodEnd,
    });
  });

  it('defaults to real zeros/empty breakdowns for all three domains when nothing was flagged this period', async () => {
    const repos = createFakeRepos({ items: [], business: BUSINESS });
    const generator = fakeGenerator();
    const service = new SummaryService(repos, generator, TEST_MODEL, PERMISSIVE_SPEND_LIMITS);

    await service.generateForPeriod({ businessId: BUSINESS_A, periodType: 'weekly', periodStart, periodEnd });

    const call = vi.mocked(generator.generate).mock.calls[0]![0] as SummaryGenerationInput;
    expect(call.criticalIncidents).toEqual({ count: 0, unacknowledgedCount: 0 });
    expect(call.fraudSignals).toEqual({ count: 0, severityBreakdown: [] });
    expect(call.loyaltyActivity).toEqual({ count: 0, typeBreakdown: [] });
  });
});
