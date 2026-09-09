import type { Repositories } from '../repositories';
import type { Feedback } from '../repositories/feedback.repository';
import type { FeedbackSummary } from '../repositories/feedback-summary.repository';
import {
  createSummaryGenerator,
  PROMPT_VERSION,
  type LabeledCount,
  type SummaryGenerationResult,
  type SummaryGenerator,
} from './summary-generator';
import { computePreviousPeriodRange, formatPeriodLabel } from './period';
import { redactComment } from './redaction';
import { AppError } from '../lib/errors';

export interface GenerateSummaryOptions {
  businessId: string;
  branchId?: string | undefined;
  periodType: 'daily' | 'weekly' | 'monthly';
  periodStart: Date;
  periodEnd: Date;
}

/** S4.2 daily/monthly Anthropic spend-limit thresholds, in USD. Platform-wide
 * (not per-business) -- see AiUsageLogRepository.totalCostSince's doc comment
 * for why. Sourced from wrangler.toml's ANTHROPIC_DAILY_SPEND_LIMIT_USD /
 * ANTHROPIC_MONTHLY_SPEND_LIMIT_USD [vars] via createSummaryService. */
export interface SpendLimits {
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

// Caps how many raw comments get sent to the LLM per generation, regardless
// of how much feedback a period contains -- a deliberate cost/latency
// guardrail on an external paid API call, not a product-facing limit (see
// "never hard-code limits," which is about business-configurable behavior
// like point rates, not this kind of infrastructure safety valve).
const MAX_COMMENTS_IN_PROMPT = 100;

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * S4.1 "sentiment/category/urgency distributions" (S4 roadmap Block 4) --
 * non-zero buckets only, sorted by count descending. `null` (not yet
 * classified by the async Level 2 pipeline -- feedback-classifier.ts --
 * or never classified for a comment-less rating-only submission) becomes
 * an explicit 'unclassified' bucket instead of being silently dropped, so
 * a slow-classifying period (especially a fresh daily one, S4.1 roadmap
 * Block 3) doesn't quietly understate itself to the LLM -- every item in
 * `items` is accounted for in exactly one bucket, and the bucket counts
 * always sum to items.length.
 */
function computeBreakdown(items: Feedback[], keyOf: (item: Feedback) => string | null): LabeledCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item) ?? 'unclassified';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Orchestrates one period's summary: pulls classified feedback
 * (SentimentService must have already run on it -- this reads
 * `feedback.sentiment`, it doesn't compute it), aggregates counts, calls the
 * LLM, and persists the result as a new `feedback_summaries` row.
 */
export class SummaryService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'feedback' | 'feedbackSummaries' | 'businesses' | 'branches' | 'aiUsageLog'
    >,
    private readonly generator: SummaryGenerator,
    /** The configured ANTHROPIC_MODEL, independent of the generator's own
     * internal copy -- needed for 'blocked'/'failed' ai_usage_log rows,
     * where no SummaryGenerationResult (and so no result.usage.model) ever
     * exists to read it from. A successful call still logs
     * result.usage.model instead of this field -- see enforceSpendLimit's
     * and the catch block's doc comments below for why the two can
     * legitimately differ (dev/staging's ConsoleSummaryGenerator). */
    private readonly model: string,
    private readonly spendLimits: SpendLimits,
  ) {}

  async generateForPeriod(options: GenerateSummaryOptions): Promise<FeedbackSummary> {
    const { businessId, branchId, periodType, periodStart, periodEnd } = options;

    const business = await this.repos.businesses.findById(businessId);
    if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');

    const branch = branchId ? await this.repos.branches.findById(branchId, businessId) : undefined;
    if (branchId && !branch) throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');

    // S4.2 spend-limit check -- after existence checks (a bad businessId/
    // branchId should 404, not be masked by an unrelated spend block) but
    // before any feedback is read or the generator is called, so a blocked
    // attempt never does the work of building a prompt it isn't allowed to
    // send.
    await this.enforceSpendLimit(options);

    const items = await this.repos.feedback.listForPeriod(businessId, {
      branchId,
      from: periodStart,
      to: periodEnd,
    });

    const positiveCount = items.filter((i) => i.sentiment === 'positive').length;
    const neutralCount = items.filter((i) => i.sentiment === 'neutral').length;
    const negativeCount = items.filter((i) => i.sentiment === 'negative').length;

    // S4.1 "sentiment/category/urgency distributions" (S4 roadmap Block 4)
    // -- computed from the same `items` this period already fetched, no
    // extra query needed.
    const categoryBreakdown = computeBreakdown(items, (i) => i.category);
    const urgencyBreakdown = computeBreakdown(items, (i) => i.urgency);

    // S4.1 "changes from previous periods" (S4 roadmap Block 4) -- same
    // business/branch scope, same duration, the immediately-prior window.
    // Reuses listForPeriod rather than a new aggregate-only repository
    // method -- simplest robust option for this block; doubles feedback
    // reads per generation, disclosed in this block's own delivery note.
    const previousRange = computePreviousPeriodRange(periodStart, periodEnd);
    const previousItems = await this.repos.feedback.listForPeriod(businessId, {
      branchId,
      from: previousRange.periodStart,
      to: previousRange.periodEnd,
    });
    const previousPeriod = {
      periodLabel: formatPeriodLabel(previousRange.periodStart, previousRange.periodEnd),
      feedbackCount: previousItems.length,
      positiveCount: previousItems.filter((i) => i.sentiment === 'positive').length,
      neutralCount: previousItems.filter((i) => i.sentiment === 'neutral').length,
      negativeCount: previousItems.filter((i) => i.sentiment === 'negative').length,
    };

    // S4.1/S4.2 (Block 2) -- redacted before this row's own comment/name/
    // email/phone context is lost by flattening to a plain string[] below.
    // redactComment's generic email/phone patterns run regardless; the
    // known-identifiers pass additionally strips THIS row's own submitter
    // info if it's restated in the comment text (see redaction.ts's doc
    // comment for what this does and deliberately does not attempt).
    const comments = items
      .map((i) => {
        const trimmed = i.comment?.trim();
        return trimmed ? redactComment(trimmed, [i.customerName, i.customerEmail, i.customerPhone]) : undefined;
      })
      .filter((c): c is string => Boolean(c))
      .slice(0, MAX_COMMENTS_IN_PROMPT);

    let result: SummaryGenerationResult;
    try {
      result = await this.generator.generate({
        businessName: business.name,
        branchName: branch?.name,
        periodLabel: formatPeriodLabel(periodStart, periodEnd),
        feedbackCount: items.length,
        positiveCount,
        neutralCount,
        negativeCount,
        comments,
        categoryBreakdown,
        urgencyBreakdown,
        previousPeriod,
      });
    } catch (err) {
      // this.model, not result.usage.model -- no result exists to read it
      // from; this.model is what the attempt actually used (or would have,
      // for a request that failed before Anthropic responded).
      await this.repos.aiUsageLog.record({
        businessId,
        branchId: branchId ?? null,
        callSite: 'summary_generation',
        model: this.model,
        promptVersion: PROMPT_VERSION,
        periodType,
        periodStart,
        periodEnd,
        inputTokens: null,
        outputTokens: null,
        costEstimateUsd: null,
        status: 'failed',
      });
      throw err;
    }

    // result.usage.model/.promptVersion, not this.model/PROMPT_VERSION --
    // what the generator that actually ran reports about itself (in
    // dev/staging, ConsoleSummaryGenerator honestly reports
    // 'console-dev-fallback' and zero cost rather than this.model, which
    // was configured but never actually called).
    await this.repos.aiUsageLog.record({
      businessId,
      branchId: branchId ?? null,
      callSite: 'summary_generation',
      model: result.usage.model,
      promptVersion: result.usage.promptVersion,
      periodType,
      periodStart,
      periodEnd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costEstimateUsd: result.usage.costEstimateUsd,
      status: 'success',
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

  /**
   * S4.2's daily/monthly spend-limit requirement. Writes its own 'blocked'
   * ai_usage_log row before throwing -- the only status this service ever
   * records without calling the generator at all -- so a business whose
   * summary silently stopped appearing has a visible, queryable reason on
   * this table (WHERE status = 'blocked') instead of just a gap where a
   * feedback_summaries row should be. Throws a 429 AppError, exactly like
   * BUSINESS_NOT_FOUND/BRANCH_NOT_FOUND above -- caught the same generic way
   * by whichever caller invoked generateForPeriod (today, always the queue
   * consumer's per-message catch/retry in index.ts; a limit that's still
   * exceeded after 3 retries reaches the DLQ, which is the correct outcome
   * for a systemic "budget exhausted" condition, not a silently-dropped job).
   */
  private async enforceSpendLimit(options: GenerateSummaryOptions): Promise<void> {
    const now = new Date();
    const [dailySpend, monthlySpend] = await Promise.all([
      this.repos.aiUsageLog.totalCostSince(startOfUtcDay(now)),
      this.repos.aiUsageLog.totalCostSince(startOfUtcMonth(now)),
    ]);

    if (dailySpend < this.spendLimits.dailyLimitUsd && monthlySpend < this.spendLimits.monthlyLimitUsd) {
      return;
    }

    await this.repos.aiUsageLog.record({
      businessId: options.businessId,
      branchId: options.branchId ?? null,
      callSite: 'summary_generation',
      model: this.model,
      promptVersion: PROMPT_VERSION,
      periodType: options.periodType,
      periodStart: options.periodStart,
      periodEnd: options.periodEnd,
      inputTokens: null,
      outputTokens: null,
      costEstimateUsd: null,
      status: 'blocked',
    });

    throw new AppError(
      'Anthropic spend limit reached; summary generation is temporarily blocked.',
      429,
      'AI_SPEND_LIMIT_EXCEEDED',
    );
  }
}

/** Convenience factory mirroring createSentimentService -- builds the
 * environment-appropriate generator (real Anthropic vs. dev console) so
 * callers (queue consumer, analytics.routes.ts) don't wire that up themselves. */
export function createSummaryService(
  repos: Pick<Repositories, 'feedback' | 'feedbackSummaries' | 'businesses' | 'branches' | 'aiUsageLog'>,
  environment: 'development' | 'staging' | 'production',
  apiKey: string,
  model: string,
  spendLimits: SpendLimits,
): SummaryService {
  return new SummaryService(repos, createSummaryGenerator(environment, apiKey, model), model, spendLimits);
}
