import { describe, it, expect } from 'vitest';
import { calculateCostUsd, ConsoleSummaryGenerator, PROMPT_VERSION } from './summary-generator';

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

    const result = await generator.generate({
      businessName: 'Test Business',
      periodLabel: '2026-07-01 to 2026-07-08',
      feedbackCount: 3,
      positiveCount: 2,
      neutralCount: 1,
      negativeCount: 0,
      comments: [],
    });

    expect(result.usage).toEqual({
      model: 'console-dev-fallback',
      promptVersion: PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      costEstimateUsd: 0,
    });
  });
});
