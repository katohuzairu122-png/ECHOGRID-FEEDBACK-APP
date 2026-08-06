export interface FollowUpQuestionInput {
  /** 1-5, already validated by the caller's Zod schema. */
  rating: number;
  /** Already trimmed/capped by the caller, same division of responsibility
   * as SummaryGenerationInput.comments. */
  comment?: string | undefined;
}

export interface FollowUpQuestionResult {
  question: string;
}

/**
 * Abstraction over "turn a rating+comment into one optional follow-up
 * question," mirroring SummaryGenerator's shape -- AnthropicFollowUpQuestionGenerator
 * is the real implementation, ConsoleFollowUpQuestionGenerator is the
 * dev/staging fallback, and createFollowUpQuestionGenerator() selects
 * between them by ENVIRONMENT, never left to the caller.
 */
export interface FollowUpQuestionGenerator {
  generate(input: FollowUpQuestionInput): Promise<FollowUpQuestionResult>;
}

/** Cost/latency guardrail on the comment text fed into the prompt, same
 * reasoning as summary.service.ts's MAX_COMMENTS_IN_PROMPT -- independent
 * of submitFeedbackSchema's 2000-char storage cap, which is about storage,
 * not prompt cost. */
const MAX_COMMENT_CHARS_IN_PROMPT = 500;

function buildPrompt(input: FollowUpQuestionInput): string {
  const commentBlock = input.comment
    ? `Their written comment: "${input.comment.slice(0, MAX_COMMENT_CHARS_IN_PROMPT)}"`
    : 'They left no written comment.';

  const framing =
    input.rating === 5
      ? 'They gave the maximum 5-star rating. Write ONE short, warm follow-up question inviting them to share what made the visit great, and any suggestions to keep it up. Stay positive -- never imply anything went wrong.'
      : `They gave a ${input.rating}-star rating out of 5 (room for improvement). Write ONE short, considerate follow-up question inviting them to share what went wrong or what could be better. Never sound defensive or accusatory.`;

  return [
    'You are drafting a single optional follow-up question for an anonymous customer feedback form.',
    framing,
    commentBlock,
    'Requirements: exactly one sentence, under 20 words, conversational, no greeting or sign-off, no surrounding quotation marks, plain text only.',
    'Respond with ONLY the question text and nothing else.',
  ].join('\n');
}

export class AnthropicFollowUpQuestionGenerator implements FollowUpQuestionGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(input: FollowUpQuestionInput): Promise<FollowUpQuestionResult> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        // One short sentence -- far below summary-generator's 1024.
        max_tokens: 128,
        messages: [{ role: 'user', content: buildPrompt(input) }],
      }),
    });

    if (!response.ok) {
      // Response body isn't logged verbatim -- same caution as
      // TwilioSmsService/AnthropicSummaryGenerator, in case it ever echoes
      // request content back.
      throw new Error(`Anthropic API request failed with status ${response.status}`);
    }

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((block) => block.type === 'text')?.text;
    if (!text) {
      throw new Error('Anthropic API returned no text content.');
    }

    return { question: text.trim() };
  }
}

/** Dev/staging fallback -- deterministic, no network call, so local work on
 * the feedback flow never spends real Anthropic credit. */
export class ConsoleFollowUpQuestionGenerator implements FollowUpQuestionGenerator {
  async generate(input: FollowUpQuestionInput): Promise<FollowUpQuestionResult> {
    console.log(
      `[ConsoleFollowUpQuestionGenerator] would generate a follow-up question for a ${input.rating}-star rating`,
    );
    return {
      question:
        input.rating === 5
          ? '[DEV MODE] What made this visit great, and any suggestions to keep it up?'
          : '[DEV MODE] What could we have done better?',
    };
  }
}

export function createFollowUpQuestionGenerator(
  environment: 'development' | 'staging' | 'production',
  apiKey: string,
  model: string,
): FollowUpQuestionGenerator {
  return environment === 'production'
    ? new AnthropicFollowUpQuestionGenerator(apiKey, model)
    : new ConsoleFollowUpQuestionGenerator();
}
