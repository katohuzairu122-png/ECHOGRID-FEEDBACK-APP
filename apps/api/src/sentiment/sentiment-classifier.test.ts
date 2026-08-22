import { describe, it, expect, vi } from 'vitest';
import { SentimentClassifier } from './sentiment-classifier';

/** Minimal fake of the Workers AI binding -- only `.run()` is ever called. */
function fakeAi(response: unknown) {
  return { run: vi.fn().mockResolvedValue(response) } as unknown as Ai;
}

describe('SentimentClassifier.classifyText', () => {
  it('classifies a very confident POSITIVE result as very_positive with a positive score', async () => {
    const classifier = new SentimentClassifier(fakeAi([{ label: 'POSITIVE', score: 0.95 }]));
    const result = await classifier.classifyText('Loved the service!');
    expect(result.sentiment).toBe('very_positive');
    expect(result.score).toBeGreaterThan(0);
  });

  it('classifies a moderately confident POSITIVE result as positive, not very_positive', async () => {
    const classifier = new SentimentClassifier(fakeAi([{ label: 'POSITIVE', score: 0.5 }]));
    const result = await classifier.classifyText('Pretty good overall.');
    expect(result.sentiment).toBe('positive');
  });

  it('classifies a very confident NEGATIVE result as very_negative with a negative score', async () => {
    const classifier = new SentimentClassifier(fakeAi([{ label: 'NEGATIVE', score: 0.9 }]));
    const result = await classifier.classifyText('Terrible wait time.');
    expect(result.sentiment).toBe('very_negative');
    expect(result.score).toBeLessThan(0);
  });

  it('classifies a moderately confident NEGATIVE result as negative, not very_negative', async () => {
    const classifier = new SentimentClassifier(fakeAi([{ label: 'NEGATIVE', score: 0.5 }]));
    const result = await classifier.classifyText('Not great, honestly.');
    expect(result.sentiment).toBe('negative');
  });

  it('buckets a low-confidence result as neutral even though the model picked a label -- inside the NEUTRAL_BAND, not on the label alone', async () => {
    // 0.55 confidence signed positive = 0.55, which IS outside the 0.15 band,
    // so use a value close enough to 0 to land inside it after signing.
    const classifier = new SentimentClassifier(fakeAi([{ label: 'POSITIVE', score: 0.1 }]));
    const result = await classifier.classifyText('It was fine.');
    expect(result.sentiment).toBe('neutral');
  });

  it('throws on an empty response array instead of guessing', async () => {
    const classifier = new SentimentClassifier(fakeAi([]));
    await expect(classifier.classifyText('...')).rejects.toThrow(
      'Workers AI returned an unexpected classification response.',
    );
  });

  it('throws when the response has no numeric score', async () => {
    const classifier = new SentimentClassifier(fakeAi([{ label: 'POSITIVE' }]));
    await expect(classifier.classifyText('...')).rejects.toThrow();
  });
});

describe('SentimentClassifier.classifyRating', () => {
  const classifier = new SentimentClassifier(fakeAi(undefined));

  it('maps a 1-star rating to very_negative and a 2-star rating to negative', () => {
    expect(classifier.classifyRating(1).sentiment).toBe('very_negative');
    expect(classifier.classifyRating(2).sentiment).toBe('negative');
  });

  it('maps a 3-star rating to neutral -- the exact midpoint', () => {
    expect(classifier.classifyRating(3).sentiment).toBe('neutral');
    expect(classifier.classifyRating(3).score).toBe(0);
  });

  it('maps a 4-star rating to positive and a 5-star rating to very_positive', () => {
    expect(classifier.classifyRating(4).sentiment).toBe('positive');
    expect(classifier.classifyRating(5).sentiment).toBe('very_positive');
  });

  it('never calls the AI binding -- fully deterministic, no inference spent', () => {
    const ai = fakeAi(undefined);
    const c = new SentimentClassifier(ai);
    c.classifyRating(5);
    expect(ai.run).not.toHaveBeenCalled();
  });
});
