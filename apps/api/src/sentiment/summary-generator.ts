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

export interface SummaryGenerationResult {
  summary: string;
  recommendations: string;
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

function parseModelOutput(text: string): SummaryGenerationResult {
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

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((block) => block.type === 'text')?.text;
    if (!text) {
      throw new Error('Anthropic API returned no text content.');
    }

    return parseModelOutput(text);
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
