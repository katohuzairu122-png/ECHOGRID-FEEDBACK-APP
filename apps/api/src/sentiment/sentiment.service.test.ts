import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentimentService } from './sentiment.service';
import type { SentimentClassifier } from './sentiment-classifier';
import type { Feedback, FeedbackRepository } from '../repositories/feedback.repository';

const BUSINESS_A = 'business-a';

function makeFeedback(overrides: Partial<Feedback> = {}): Feedback {
  return {
    id: 'feedback-1',
    businessId: BUSINESS_A,
    branchId: 'branch-1',
    qrCodeId: 'qr-1',
    rating: 5,
    comment: null,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    status: 'new',
    sentiment: null,
    sentimentScore: null,
    analysisStatus: 'pending',
    analyzedAt: null,
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

/** In-memory fake, same spirit as branch.service.test.ts's -- only the two
 * FeedbackRepository methods SentimentService actually calls. */
function createFakeFeedbackRepo(seed: Feedback[]) {
  const rows = new Map(seed.map((f) => [f.id, { ...f }]));
  return {
    async findById(id: string, businessId: string): Promise<Feedback | undefined> {
      const row = rows.get(id);
      return row && row.businessId === businessId ? row : undefined;
    },
    async updateSentiment(
      id: string,
      businessId: string,
      patch: Partial<Feedback>,
    ): Promise<Feedback | undefined> {
      const row = rows.get(id);
      if (!row || row.businessId !== businessId) return undefined;
      Object.assign(row, patch);
      return row;
    },
    rows,
  };
}

function fakeClassifier(): SentimentClassifier {
  return {
    classifyText: vi.fn(),
    classifyRating: vi.fn(),
  } as unknown as SentimentClassifier;
}

describe('SentimentService.classifyAndStore', () => {
  let classifier: SentimentClassifier;

  beforeEach(() => {
    classifier = fakeClassifier();
  });

  it('classifies via comment text when a comment is present, not the rating fallback', async () => {
    const repo = createFakeFeedbackRepo([makeFeedback({ comment: '  Great service!  ' })]);
    vi.mocked(classifier.classifyText).mockResolvedValue({ sentiment: 'positive', score: 0.8 });
    const service = new SentimentService(
      { feedback: repo as unknown as FeedbackRepository },
      classifier,
    );

    const updated = await service.classifyAndStore('feedback-1', BUSINESS_A);

    // Trimmed before being handed to the classifier -- leading/trailing
    // whitespace shouldn't affect what gets analyzed.
    expect(classifier.classifyText).toHaveBeenCalledWith('Great service!');
    expect(classifier.classifyRating).not.toHaveBeenCalled();
    expect(updated.sentiment).toBe('positive');
    expect(updated.analysisStatus).toBe('completed');
  });

  it('falls back to the deterministic rating classifier when there is no comment', async () => {
    const repo = createFakeFeedbackRepo([makeFeedback({ comment: null, rating: 2 })]);
    vi.mocked(classifier.classifyRating).mockReturnValue({ sentiment: 'negative', score: -0.5 });
    const service = new SentimentService(
      { feedback: repo as unknown as FeedbackRepository },
      classifier,
    );

    const updated = await service.classifyAndStore('feedback-1', BUSINESS_A);

    expect(classifier.classifyRating).toHaveBeenCalledWith(2);
    expect(classifier.classifyText).not.toHaveBeenCalled();
    expect(updated.sentiment).toBe('negative');
  });

  it('treats a comment of only whitespace the same as no comment at all', async () => {
    const repo = createFakeFeedbackRepo([makeFeedback({ comment: '   ', rating: 4 })]);
    vi.mocked(classifier.classifyRating).mockReturnValue({ sentiment: 'positive', score: 0.5 });
    const service = new SentimentService(
      { feedback: repo as unknown as FeedbackRepository },
      classifier,
    );

    await service.classifyAndStore('feedback-1', BUSINESS_A);

    expect(classifier.classifyRating).toHaveBeenCalled();
    expect(classifier.classifyText).not.toHaveBeenCalled();
  });

  it('throws FEEDBACK_NOT_FOUND for an unknown id', async () => {
    const repo = createFakeFeedbackRepo([]);
    const service = new SentimentService(
      { feedback: repo as unknown as FeedbackRepository },
      classifier,
    );

    await expect(service.classifyAndStore('missing', BUSINESS_A)).rejects.toMatchObject({
      code: 'FEEDBACK_NOT_FOUND',
      status: 404,
    });
  });

  it('marks the row "failed" and rethrows when the classifier throws -- never leaves it stuck at pending', async () => {
    const repo = createFakeFeedbackRepo([makeFeedback({ comment: 'test' })]);
    vi.mocked(classifier.classifyText).mockRejectedValue(new Error('AI binding unavailable'));
    const service = new SentimentService(
      { feedback: repo as unknown as FeedbackRepository },
      classifier,
    );

    await expect(service.classifyAndStore('feedback-1', BUSINESS_A)).rejects.toThrow(
      'AI binding unavailable',
    );

    const row = repo.rows.get('feedback-1');
    expect(row?.analysisStatus).toBe('failed');
    expect(row?.analyzedAt).not.toBeNull();
  });

  it('is idempotent under redelivery -- classifying the same row twice just overwrites, never errors on the second call', async () => {
    const repo = createFakeFeedbackRepo([makeFeedback({ comment: 'test' })]);
    vi.mocked(classifier.classifyText)
      .mockResolvedValueOnce({ sentiment: 'positive', score: 0.5 })
      .mockResolvedValueOnce({ sentiment: 'negative', score: -0.5 });
    const service = new SentimentService(
      { feedback: repo as unknown as FeedbackRepository },
      classifier,
    );

    await service.classifyAndStore('feedback-1', BUSINESS_A);
    const second = await service.classifyAndStore('feedback-1', BUSINESS_A);

    expect(second.sentiment).toBe('negative');
  });
});
