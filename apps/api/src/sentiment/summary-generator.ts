/** Shared shape for both categoryBreakdown and urgencyBreakdown below --
 * the two are structurally identical (a label plus a count), so one type
 * covers both rather than two near-duplicate interfaces (S4 roadmap
 * Block 4). */
export interface LabeledCount {
  label: string;
  count: number;
}

/** Same-scope (business/branch), same-duration window immediately before
 * this period -- always real counts, never a sentinel "no data" value: a
 * period with genuinely zero prior feedback (e.g. a brand-new branch's
 * first day) is accurately represented as zeros, not specially flagged.
 * The LLM is instructed (see buildPrompt) not to force a comparison
 * narrative the numbers don't support, which covers this case without
 * needing a separate "no previous period" state here. */
export interface PreviousPeriodComparison {
  periodLabel: string;
  feedbackCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
}

/** S4 roadmap Block 5 "cross-domain aggregates" -- critical_incidents has
 * no natural breakdown dimension the way fraud severity/loyalty type do
 * (matchedSignals is free-text, comma-joined keyword tokens, not a closed
 * set worth bucketing); count plus how many are still unacknowledged is
 * the actionable operational signal instead. */
export interface CriticalIncidentsSummary {
  count: number;
  unacknowledgedCount: number;
}

/** severityBreakdown reuses the same LabeledCount/computeBreakdown
 * convention as categoryBreakdown/urgencyBreakdown -- severity is a
 * small, closed, CHECK-constrained scale (low/medium/high), the same
 * class of field. */
export interface FraudSignalsSummary {
  count: number;
  severityBreakdown: LabeledCount[];
}

/** Always business-wide, never branch-scoped -- loyalty_transactions has
 * no branchId of its own (see LoyaltyTransactionRepository
 * .listForBusinessPeriod's own comment for why). buildPrompt labels this
 * explicitly so a branch-scoped summary doesn't read as if this figure
 * were also branch-scoped. */
export interface LoyaltyActivitySummary {
  count: number;
  typeBreakdown: LabeledCount[];
}

export interface SummaryGenerationInput {
  businessName: string;
  branchName?: string | undefined;
  periodLabel: string;
  feedbackCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  /** Comment text only, already capped AND PII-redacted by the caller
   * (SummaryService, via sentiment/redaction.ts's redactComment -- S4.1/S4.2,
   * Block 2) -- this module doesn't know or enforce either guarantee,
   * keeping both the cost/prompt-size and the privacy guardrail in one
   * place (the caller). */
  comments: string[];
  /** S4.1 "sentiment/category/urgency distributions" -- non-zero buckets
   * only, sorted by count descending (SummaryService.computeBreakdown).
   * An empty array is a genuine "nothing classified yet," not an omission
   * -- buildPrompt renders it as such rather than a blank line. */
  categoryBreakdown: LabeledCount[];
  /** Same non-zero/sorted convention as categoryBreakdown. */
  urgencyBreakdown: LabeledCount[];
  /** S4.1 "changes from previous periods". */
  previousPeriod: PreviousPeriodComparison;
  /** S4.1 "cross-domain content (critical incidents/loyalty/fraud)" (S4
   * roadmap Block 5). Same business/branch scope as categoryBreakdown/
   * urgencyBreakdown above. */
  criticalIncidents: CriticalIncidentsSummary;
  /** Same scope as criticalIncidents above. */
  fraudSignals: FraudSignalsSummary;
  /** Business-wide, not branch-scoped -- see LoyaltyActivitySummary's own
   * doc comment for why. */
  loyaltyActivity: LoyaltyActivitySummary;
}

/**
 * S4.2 "record model, prompt version, input size, output size, cost
 * estimate" -- carried on every result so SummaryService can log it without
 * needing its own copy of pricing/model knowledge (that stays here, next to
 * the code that actually knows which model made the call and what it
 * returned). ConsoleSummaryGenerator reports real, honest zeros -- it never
 * calls the real API, so it genuinely costs nothing -- rather than omitting
 * usage, so a dev/staging summary still writes a complete (harmless)
 * ai_usage_log row instead of SummaryService needing an `if` to skip it.
 */
export interface SummaryGenerationUsage {
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number;
}

export interface SummaryGenerationResult {
  summary: string;
  recommendations: string;
  usage: SummaryGenerationUsage;
}

/**
 * Abstraction over "turn a period's feedback into prose," mirroring
 * SmsService's shape -- AnthropicSummaryGenerator is the real implementation,
 * ConsoleSummaryGenerator is the dev/staging fallback so local work never
 * spends real Anthropic credit, and createSummaryGenerator() selects between
 * them by ENVIRONMENT, never left to the caller.
 */
export interface SummaryGenerator {
  generate(input: SummaryGenerationInput): Promise<SummaryGenerationResult>;
}

/** Bump whenever buildPrompt's template changes materially (wording,
 * structure, what data it includes) -- recorded on every ai_usage_log row
 * (S4.2 "record ... prompt version") so a cost or output-quality shift can
 * be traced back to which prompt version produced it. Bumped to v2 for S4
 * roadmap Block 4 (category/urgency breakdowns + period-over-period
 * comparison added to the prompt body); bumped to v3 for Block 5
 * (critical incident/fraud signal/loyalty activity cross-domain content
 * added to the prompt body). */
export const PROMPT_VERSION = 'summary-v3';

/**
 * Per-million-token USD pricing for models this codebase might set
 * ANTHROPIC_MODEL to. Sourced from Anthropic's own pricing page
 * (platform.claude.com/docs/en/about-claude/pricing, confirmed 2026-09-04):
 * claude-sonnet-5 is $2/M input tokens and $10/M output tokens -- the
 * standard (non-promotional) rate as of that date. Re-confirm against
 * Anthropic's docs before adding a new model here, same "don't hard-code
 * without checking" discipline wrangler.toml's own ANTHROPIC_MODEL comment
 * already asks for when that value changes.
 */
const MODEL_PRICING_USD_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
};

/**
 * Computes a real dollar estimate from Anthropic's own reported token usage
 * (S4.2 "cost estimate"). Throws for an unrecognized model instead of
 * silently estimating $0 -- an unpriced model would otherwise make
 * SummaryService's spend-limit check blind to real spend, which is worse
 * than a loud failure telling whoever changed ANTHROPIC_MODEL to add a
 * pricing entry above first.
 */
export function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) {
    throw new Error(
      `No pricing entry for Anthropic model "${model}" -- add one to MODEL_PRICING_USD_PER_MILLION_TOKENS (summary-generator.ts) before using this model, so cost tracking and the spend-limit check stay accurate.`,
    );
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

const SUMMARY_MARKER = 'SUMMARY:';
const RECOMMENDATIONS_MARKER = 'RECOMMENDATIONS:';

/**
 * Plain-text section markers instead of a JSON response format -- a stray
 * formatting quirk in an LLM's JSON breaks a strict parse entirely, while a
 * missing/misplaced marker here just degrades gracefully to "put everything
 * in the summary field" (see the fallback below). Matches the reasoning
 * already documented on `feedback_summaries.recommendations` in the Block 1
 * schema comment.
 */
/** `"label (count)"`, comma-joined -- shared rendering for both
 * categoryBreakdown and urgencyBreakdown (S4 roadmap Block 4). */
function formatCounts(items: LabeledCount[]): string {
  return items.map((item) => `${item.label} (${item.count})`).join(', ');
}

/** Exported (was private) as of S4 roadmap Block 4 specifically so its new
 * category/urgency/period-over-period content is directly unit-testable
 * without mocking `fetch` -- see summary-generator.test.ts. Still a pure
 * function with no side effects; AnthropicSummaryGenerator.generate is the
 * only real caller. */
export function buildPrompt(input: SummaryGenerationInput): string {
  const scope = input.branchName ? `${input.businessName} (${input.branchName} branch)` : input.businessName;
  const commentBlock =
    input.comments.length > 0
      ? input.comments.map((c, i) => `${i + 1}. "${c}"`).join('\n')
      : '(No written comments this period -- ratings only.)';

  const categoryLine =
    input.categoryBreakdown.length > 0
      ? `Category breakdown: ${formatCounts(input.categoryBreakdown)}.`
      : 'Category breakdown: no classified feedback this period.';
  const urgencyLine =
    input.urgencyBreakdown.length > 0
      ? `Urgency breakdown: ${formatCounts(input.urgencyBreakdown)}.`
      : 'Urgency breakdown: no classified feedback this period.';
  const prev = input.previousPeriod;
  const comparisonLine =
    `Compared to the previous period (${prev.periodLabel}): ${prev.feedbackCount} submissions previously ` +
    `(now ${input.feedbackCount}), ${prev.positiveCount} positive previously (now ${input.positiveCount}), ` +
    `${prev.neutralCount} neutral previously (now ${input.neutralCount}), ${prev.negativeCount} negative ` +
    `previously (now ${input.negativeCount}).`;

  const ci = input.criticalIncidents;
  const criticalIncidentsLine =
    ci.count === 0
      ? 'Critical incidents: none this period.'
      : `Critical incidents: ${ci.count} this period (${ci.unacknowledgedCount} unacknowledged).`;
  const fs = input.fraudSignals;
  const fraudSignalsLine =
    fs.count === 0
      ? 'Fraud signals: none this period.'
      : `Fraud signals: ${fs.count} this period, by severity: ${formatCounts(fs.severityBreakdown)}.`;
  const la = input.loyaltyActivity;
  const loyaltyActivityLine =
    la.count === 0
      ? 'Loyalty activity (business-wide, not branch-scoped): none this period.'
      : `Loyalty activity (business-wide, not branch-scoped): ${la.count} transactions this period, by type: ${formatCounts(la.typeBreakdown)}.`;

  return [
    `You are a customer experience analyst for ${scope}.`,
    `Period: ${input.periodLabel}.`,
    `Feedback volume: ${input.feedbackCount} submissions (${input.positiveCount} positive, ${input.neutralCount} neutral, ${input.negativeCount} negative).`,
    categoryLine,
    urgencyLine,
    comparisonLine,
    criticalIncidentsLine,
    fraudSignalsLine,
    loyaltyActivityLine,
    '',
    'Customer comments this period:',
    commentBlock,
    '',
    'Write a concise, factual summary of what customers are saying (2-4 sentences, no speculation beyond what the comments support), followed by 2-5 specific, actionable recommendations for the business owner. Use the category, urgency, and previous-period figures above to note meaningful patterns or changes when relevant -- do not force a comparison the data does not support (e.g. a small sample or a brand-new period with nothing prior). If there are unacknowledged critical incidents or notable fraud activity this period, call them out explicitly as urgent operational items rather than folding them quietly into the general summary.',
    'Respond in exactly this format, with no other text:',
    `${SUMMARY_MARKER} <summary prose>`,
    `${RECOMMENDATIONS_MARKER} <one recommendation per line, no numbering>`,
  ].join('\n');
}

/** Just the two text fields -- usage/cost isn't computed from the model's
 * text output, so it has no place in this function's return value (the
 * caller, AnthropicSummaryGenerator.generate, assembles the full
 * SummaryGenerationResult separately once it also has data.usage in hand). */
function parseModelOutput(text: string): Pick<SummaryGenerationResult, 'summary' | 'recommendations'> {
  const recIndex = text.indexOf(RECOMMENDATIONS_MARKER);
  const summaryIndex = text.indexOf(SUMMARY_MARKER);

  if (summaryIndex === -1 || recIndex === -1 || recIndex < summaryIndex) {
    // Markers missing/out of order -- never invent structure that isn't
    // there. The whole response becomes the summary; recommendations says so
    // explicitly rather than silently showing an empty list a staff member
    // might mistake for "no recommendations."
    return {
      summary: text.trim(),
      recommendations: '(The AI response could not be parsed into recommendations. See summary above.)',
    };
  }

  const summary = text.slice(summaryIndex + SUMMARY_MARKER.length, recIndex).trim();
  const recommendations = text.slice(recIndex + RECOMMENDATIONS_MARKER.length).trim();
  return { summary, recommendations };
}

export class AnthropicSummaryGenerator implements SummaryGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(input: SummaryGenerationInput): Promise<SummaryGenerationResult> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: buildPrompt(input) }],
      }),
    });

    if (!response.ok) {
      // Response body isn't logged verbatim -- same caution as
      // TwilioSmsService, in case it ever echoes request content back.
      throw new Error(`Anthropic API request failed with status ${response.status}`);
    }

    const data = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = data.content?.find((block) => block.type === 'text')?.text;
    if (!text) {
      throw new Error('Anthropic API returned no text content.');
    }
    if (!data.usage) {
      // Should never happen on a 2xx Messages API response -- treated as an
      // error rather than defaulting to 0 tokens, which would silently
      // understate real spend to the caller's spend-limit check instead of
      // failing loudly.
      throw new Error('Anthropic API returned no usage data.');
    }

    const { summary, recommendations } = parseModelOutput(text);
    const { input_tokens: inputTokens, output_tokens: outputTokens } = data.usage;

    return {
      summary,
      recommendations,
      usage: {
        model: this.model,
        promptVersion: PROMPT_VERSION,
        inputTokens,
        outputTokens,
        costEstimateUsd: calculateCostUsd(this.model, inputTokens, outputTokens),
      },
    };
  }
}

/** Dev/staging fallback -- deterministic, no network call, so local runs of
 * the summary pipeline are free and offline-friendly. */
export class ConsoleSummaryGenerator implements SummaryGenerator {
  async generate(input: SummaryGenerationInput): Promise<SummaryGenerationResult> {
    console.log(
      `[ConsoleSummaryGenerator] would summarize ${input.feedbackCount} submissions for ${input.businessName} (${input.periodLabel})`,
    );
    return {
      summary: `[DEV MODE] ${input.feedbackCount} submissions this period (${input.positiveCount} positive, ${input.neutralCount} neutral, ${input.negativeCount} negative). Real AI summaries are generated only when ANTHROPIC_API_KEY is configured in production.`,
      recommendations: '[DEV MODE] Configure ANTHROPIC_API_KEY in production to see real recommendations.',
      // Real, honest zeros -- this path never calls the real API, so it
      // genuinely costs nothing (see SummaryGenerationUsage's doc comment).
      usage: { model: 'console-dev-fallback', promptVersion: PROMPT_VERSION, inputTokens: 0, outputTokens: 0, costEstimateUsd: 0 },
    };
  }
}

export function createSummaryGenerator(
  environment: 'development' | 'staging' | 'production',
  apiKey: string,
  model: string,
): SummaryGenerator {
  return environment === 'production'
    ? new AnthropicSummaryGenerator(apiKey, model)
    : new ConsoleSummaryGenerator();
}
