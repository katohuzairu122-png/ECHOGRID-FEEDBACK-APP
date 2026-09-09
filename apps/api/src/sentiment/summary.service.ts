import type { Repositories } from '../repositories';
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
 * Generic over T (S4 roadmap Block 5 -- originally Feedback-only for
 * category/urgency, widened to also bucket FraudSignal.severity and
 * LoyaltyTransaction.type, same shape). Non-zero buckets only, sorted by
 * count descending. `null` becomes an explicit 'unclassified' bucket
 * instead of being silently dropped, so a slow-classifying period
 * (feedback.category/urgency: not yet reached by the async Level 2
 * pipeline -- feedback-classifier.ts) doesn't quietly understate itself to
 * the LLM -- every item in `items` is accounted for in exactly one bucket,
 * and the bucket counts always sum to items.length. FraudSignal.severity
 * and LoyaltyTransaction.type are both NOT NULL columns, so 'unclassified'
 * never actually appears for those two callers -- keyOf's return type stays
 * `string | null` anyway so this one function still covers all three,
 * rather than a near-duplicate non-nullable variant for two of them.
 */
function computeBreakdown<T>(items: T[], keyOf: (item: T) => string | null): LabeledCount[] {
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
      | 'feedback'
      | 'feedbackSummaries'
      | 'businesses'
      | 'branches'
      | 'aiUsageLog'
      | 'criticalIncidents'
      | 'fraudSignals'
      | 'loyaltyTransactions'
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

    // S4 roadmap Block 7 (S4.3 "mark processing pending or failed") -- a
    // 'pending' row exists in ai_usage_log from this point until this
    // function either returns or throws, covering both the reads below and
    // the actual Anthropic call, so an attempt that starts but never
    // reaches either resolve() call (e.g. this Worker invocation is killed
    // mid-flight) is still visible as a stuck 'pending' row instead of
    // leaving no trace anywhere. Captured as its own variable, not
    // re-queried, so both resolve() calls below update this exact row.
    const pendingLog = await this.repos.aiUsageLog.record({
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
      status: 'pending',
    });

    // S4.1 "changes from previous periods" (S4 roadmap Block 4) -- same
    // business/branch scope, same duration, the immediately-prior window.
    const previousRange = computePreviousPeriodRange(periodStart, periodEnd);

    // All five reads are independent of each other (none needs another's
    // result), so they run concurrently instead of as five sequential
    // round-trips -- S4 roadmap Block 5 adds three more reads to what
    // Block 4 already fetched here one at a time, and paying for that
    // latency serially would only get worse as more cross-domain sources
    // are added later. Array position, not named destructuring off an
    // object, preserves the exact call order existing tests already
    // assert on for feedback.listForPeriod (current period first, then
    // previous) -- Promise.all still invokes each array element
    // synchronously, in order, before awaiting any of them, so this is
    // 100% behavior-preserving for that ordering.
    const [items, previousItems, criticalIncidentRows, fraudSignalRows, loyaltyTransactionRows] = await Promise.all([
      this.repos.feedback.listForPeriod(businessId, { branchId, from: periodStart, to: periodEnd }),
      this.repos.feedback.listForPeriod(businessId, {
        branchId,
        from: previousRange.periodStart,
        to: previousRange.periodEnd,
      }),
      this.repos.criticalIncidents.listForPeriod(businessId, { branchId, from: periodStart, to: periodEnd }),
      this.repos.fraudSignals.listForPeriod(businessId, { branchId, from: periodStart, to: periodEnd }),
      // Business-wide, never branchId-scoped -- see
      // LoyaltyTransactionRepository.listForBusinessPeriod's own comment
      // for why loyalty activity has no per-branch dimension to scope to.
      this.repos.loyaltyTransactions.listForBusinessPeriod(businessId, { from: periodStart, to: periodEnd }),
    ]);

    const positiveCount = items.filter((i) => i.sentiment === 'positive').length;
    const neutralCount = items.filter((i) => i.sentiment === 'neutral').length;
    const negativeCount = items.filter((i) => i.sentiment === 'negative').length;

    // S4.1 "sentiment/category/urgency distributions" (S4 roadmap Block 4)
    // -- computed from the same `items` this period already fetched, no
    // extra query needed.
    const categoryBreakdown = computeBreakdown(items, (i) => i.category);
    const urgencyBreakdown = computeBreakdown(items, (i) => i.urgency);

    const previousPeriod = {
      periodLabel: formatPeriodLabel(previousRange.periodStart, previousRange.periodEnd),
      feedbackCount: previousItems.length,
      positiveCount: previousItems.filter((i) => i.sentiment === 'positive').length,
      neutralCount: previousItems.filter((i) => i.sentiment === 'neutral').length,
      negativeCount: previousItems.filter((i) => i.sentiment === 'negative').length,
    };

    // S4.1 "cross-domain content (critical incidents/loyalty/fraud)" (S4
    // roadmap Block 5).
    const criticalIncidents = {
      count: criticalIncidentRows.length,
      unacknowledgedCount: criticalIncidentRows.filter((ci) => ci.acknowledgedAt === null).length,
    };
    const fraudSignals = {
      count: fraudSignalRows.length,
      severityBreakdown: computeBreakdown(fraudSignalRows, (signal) => signal.severity),
    };
    const loyaltyActivity = {
      count: loyaltyTransactionRows.length,
      typeBreakdown: computeBreakdown(loyaltyTransactionRows, (transaction) => transaction.type),
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
        criticalIncidents,
        fraudSignals,
        loyaltyActivity,
      });
    } catch (err) {
      // S4 roadmap Block 7 -- resolve() the same pending row from above,
      // not a second record(). this.model, not result.usage.model -- no
      // result exists to read it from; this.model is what the attempt
      // actually used (or would have, for a request that failed before
      // Anthropic responded) -- same values already recorded at pending
      // time, re-passed since resolve() takes a full, uniform payload.
      await this.repos.aiUsageLog.resolve(pendingLog.id, {
        status: 'failed',
        model: this.model,
        promptVersion: PROMPT_VERSION,
        inputTokens: null,
        outputTokens: null,
        costEstimateUsd: null,
      });
      throw err;
    }

    // S4 roadmap Block 7 -- resolve() the same pending row, not a second
    // record(). result.usage.model/.promptVersion, not this.model/
    // PROMPT_VERSION -- what the generator that actually ran reports about
    // itself (in dev/staging, ConsoleSummaryGenerator honestly reports
    // 'console-dev-fallback' and zero cost rather than this.model, which
    // was configured but never actually called), correcting what pending
    // time could only guess at (the configured model, not necessarily the
    // one that actually ran).
    await this.repos.aiUsageLog.resolve(pendingLog.id, {
      status: 'success',
      model: result.usage.model,
      promptVersion: result.usage.promptVersion,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costEstimateUsd: result.usage.costEstimateUsd,
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
  repos: Pick<
    Repositories,
    | 'feedback'
    | 'feedbackSummaries'
    | 'businesses'
    | 'branches'
    | 'aiUsageLog'
    | 'criticalIncidents'
    | 'fraudSignals'
    | 'loyaltyTransactions'
  >,
  environment: 'development' | 'staging' | 'production',
  apiKey: string,
  model: string,
  spendLimits: SpendLimits,
): SummaryService {
  return new SummaryService(repos, createSummaryGenerator(environment, apiKey, model), model, spendLimits);
}
