export interface SummaryGenerationInput {
  businessName: string;
  branchName?: string | undefined;
  periodLabel: string;
  feedbackCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  /** Comment text only, already capped by the caller (SummaryService) --
   * this module doesn't know or enforce the cap, keeping the cost/prompt-size
   * guardrail in one place. */
  comments: string[];
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
 * be traced back to which prompt version produced it. */
export const PROMPT_VERSION = 'summary-v1';

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
function buildPrompt(input: SummaryGenerationInput): string {
  const scope = input.branchName ? `${input.businessName} (${input.branchName} branch)` : input.businessName;
  const commentBlock =
    input.comments.length > 0
      ? input.comments.map((c, i) => `${i + 1}. "${c}"`).join('\n')
      : '(No written comments this period -- ratings only.)';

  return [
    `You are a customer experience analyst for ${scope}.`,
    `Period: ${input.periodLabel}.`,
    `Feedback volume: ${input.feedbackCount} submissions (${input.positiveCount} positive, ${input.neutralCount} neutral, ${input.negativeCount} negative).`,
    '',
    'Customer comments this period:',
    commentBlock,
    '',
    'Write a concise, factual summary of what customers are saying (2-4 sentences, no speculation beyond what the comments support), followed by 2-5 specific, actionable recommendations for the business owner.',
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
