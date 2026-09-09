import { describe, it, expect } from 'vitest';
import { buildPrompt, calculateCostUsd, ConsoleSummaryGenerator, PROMPT_VERSION } from './summary-generator';
import type { SummaryGenerationInput } from './summary-generator';

/** Base input shared by buildPrompt tests below -- only the field(s) each
 * test cares about are overridden, matching the makeFeedback()-style
 * builder convention already used in summary.service.test.ts. */
function makeInput(overrides: Partial<SummaryGenerationInput> = {}): SummaryGenerationInput {
  return {
    businessName: 'Test Business',
    periodLabel: '2026-07-02 to 2026-07-09',
    feedbackCount: 4,
    positiveCount: 2,
    neutralCount: 1,
    negativeCount: 1,
    comments: [],
    categoryBreakdown: [],
    urgencyBreakdown: [],
    previousPeriod: {
      periodLabel: '2026-06-25 to 2026-07-02',
      feedbackCount: 3,
      positiveCount: 1,
      neutralCount: 1,
      negativeCount: 1,
    },
    ...overrides,
  };
}

describe('calculateCostUsd', () => {
  it('prices claude-sonnet-5 at $2/M input tokens and $10/M output tokens', () => {
    expect(calculateCostUsd('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(2, 10);
    expect(calculateCostUsd('claude-sonnet-5', 0, 1_000_000)).toBeCloseTo(10, 10);
  });

  it('scales linearly for fractional token counts', () => {
    // 500K input @ $2/M = $1; 250K output @ $10/M = $2.5; total $3.5.
    expect(calculateCostUsd('claude-sonnet-5', 500_000, 250_000)).toBeCloseTo(3.5, 10);
  });

  it('returns exactly 0 for a zero-token call', () => {
    expect(calculateCostUsd('claude-sonnet-5', 0, 0)).toBe(0);
  });

  it('throws for a model with no pricing entry, rather than silently estimating $0', () => {
    // A silent $0 would make SummaryService's spend-limit check blind to
    // real spend on a model nobody priced yet -- loud failure is correct.
    expect(() => calculateCostUsd('some-future-model', 1000, 1000)).toThrow(/no pricing entry/i);
  });
});

describe('ConsoleSummaryGenerator', () => {
  it('reports real, honest zero usage/cost -- this path never calls the real Anthropic API', async () => {
    const generator = new ConsoleSummaryGenerator();

    const result = await generator.generate(makeInput());

    expect(result.usage).toEqual({
      model: 'console-dev-fallback',
      promptVersion: PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      costEstimateUsd: 0,
    });
  });
});

describe('buildPrompt (S4 roadmap Block 4 -- category/urgency + period-over-period)', () => {
  it('renders non-empty category and urgency breakdowns as "label (count)", comma-joined', () => {
    const prompt = buildPrompt(
      makeInput({
        categoryBreakdown: [
          { label: 'product_quality', count: 8 },
          { label: 'staff_conduct', count: 3 },
        ],
        urgencyBreakdown: [
          { label: 'P1_HIGH', count: 2 },
          { label: 'P2_NORMAL', count: 9 },
        ],
      }),
    );

    expect(prompt).toContain('Category breakdown: product_quality (8), staff_conduct (3).');
    expect(prompt).toContain('Urgency breakdown: P1_HIGH (2), P2_NORMAL (9).');
  });

  it('falls back to an explicit "no classified feedback" line when a breakdown is empty, not a blank line', () => {
    const prompt = buildPrompt(makeInput({ categoryBreakdown: [], urgencyBreakdown: [] }));

    expect(prompt).toContain('Category breakdown: no classified feedback this period.');
    expect(prompt).toContain('Urgency breakdown: no classified feedback this period.');
  });

  it('includes an unclassified bucket only when the caller actually passed one', () => {
    const prompt = buildPrompt(
      makeInput({ categoryBreakdown: [{ label: 'unclassified', count: 2 }, { label: 'pricing', count: 5 }] }),
    );

    expect(prompt).toContain('Category breakdown: unclassified (2), pricing (5).');
  });

  it('states the previous period\'s label and both periods\' counts side by side', () => {
    const prompt = buildPrompt(
      makeInput({
        feedbackCount: 12,
        positiveCount: 6,
        neutralCount: 3,
        negativeCount: 3,
        previousPeriod: {
          periodLabel: '2026-06-25 to 2026-07-02',
          feedbackCount: 9,
          positiveCount: 4,
          neutralCount: 3,
          negativeCount: 2,
        },
      }),
    );

    expect(prompt).toContain(
      'Compared to the previous period (2026-06-25 to 2026-07-02): 9 submissions previously (now 12), ' +
        '4 positive previously (now 6), 3 neutral previously (now 3), 2 negative previously (now 3).',
    );
  });

  it('renders a genuinely zero previous period as real zeros, not a special "no data" message', () => {
    const prompt = buildPrompt(
      makeInput({
        previousPeriod: { periodLabel: '2026-06-25 to 2026-07-02', feedbackCount: 0, positiveCount: 0, neutralCount: 0, negativeCount: 0 },
      }),
    );

    expect(prompt).toContain('0 submissions previously');
    expect(prompt).not.toMatch(/no (previous|prior) period/i);
  });

  it('instructs the model not to force a comparison the data does not support', () => {
    const prompt = buildPrompt(makeInput());
    expect(prompt).toMatch(/do not force a comparison/i);
  });
});
